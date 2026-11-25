import { Capacitor } from '@capacitor/core';
import { AdMob, AdmobConsentStatus, BannerAdPosition, BannerAdSize, BannerAdPluginEvents, InterstitialAdPluginEvents, RewardAdPluginEvents } from '@capacitor-community/admob';

// Gerçek cihazda tüm formatlar test reklamıyla doğrulanana kadar TEST_MODE = true kalsın.
// Google Play'e yüklemeden önce false yap.
const TEST_MODE = true;
const TEST_AD_UNITS = {
  banner: 'ca-app-pub-3940256099942544/9214589741',
  interstitial: 'ca-app-pub-3940256099942544/1033173712',
  rewarded: 'ca-app-pub-3940256099942544/5224354917',
};
const LIVE_AD_UNITS = {
  banner: 'ca-app-pub-3173758070343843/8727460148',
  interstitial: 'ca-app-pub-3173758070343843/6264627536',
  rewarded: 'ca-app-pub-3173758070343843/7985224111',
};
const AD_UNITS = TEST_MODE ? TEST_AD_UNITS : LIVE_AD_UNITS;

let initialized = false;
let initPromise = null;
let initRetryCount = 0;
let consentAllowsAds = false;
let privacyOptionsRequired = false;
let consentSnapshot = null;
let bannerVisible = false;
let bannerWanted = false;
let bannerQueue = Promise.resolve();
let interstitialReady = false;
let interstitialLoadPromise = null;
let interstitialFailCount = 0;
let rewardedReady = false;
let rewardedLoadPromise = null;
let rewardedFailCount = 0;
let rewardEarnedDuringShow = false;
let interstitialBusy = false;
let rewardedBusy = false;
let interstitialDismissResolve = null;
let rewardedDismissResolve = null;
let currentScreen = 'menu';
let lastError = '';
let lastStatus = 'Not initialized';
let listenersInstalled = false;
const recentEvents = [];

const isNative = () => Capacitor.isNativePlatform();
const isBannerScreen = screen => ['menu', 'shop', 'pg', 'end'].includes(screen);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timeout (' + ms + ' ms)')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function log(...args) {
  console.info('[Gem Rush AdMob]', ...args);
}

function recordEvent(name, detail = '') {
  const item = { time: new Date().toLocaleTimeString(), name, detail: detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '' };
  recentEvents.push(item);
  if (recentEvents.length > 20) recentEvents.shift();
  lastStatus = name;
  log(name, detail);
}

function fail(where, error) {
  lastError = `${where}: ${error?.message || error || 'Unknown error'}`;
  lastStatus = 'ERROR';
  console.error('[Gem Rush AdMob]', lastError, error);
}

function setBannerClass(visible) {
  const app = document.getElementById('app');
  if (app) app.classList.toggle('ad-banner-visible', !!visible);
}

// Eski eklenti sürümleri canRequestAds alanını döndürmez; bu durumda status'a bakılır.
function consentCanRequestAds(consent) {
  if (!consent) return false;
  if (typeof consent.canRequestAds === 'boolean') return consent.canRequestAds;
  const status = String(consent.status || '');
  return status === 'OBTAINED' || status === 'NOT_REQUIRED';
}

// Başarısız yüklemeden sonra kademeli (5s, 10s, 20s, 40s, en fazla 60s) yeniden dene.
function retryDelay(failCount) {
  return Math.min(60000, 5000 * Math.pow(2, Math.max(0, failCount - 1)));
}

async function installAdListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  const registrations = [
    [BannerAdPluginEvents.Loaded, () => recordEvent('Banner loaded')],
    [BannerAdPluginEvents.FailedToLoad, e => { lastError = 'Banner failed to load: ' + (e?.message || JSON.stringify(e)); recordEvent('Banner failed to load', e); }],
    [BannerAdPluginEvents.SizeChanged, s => recordEvent('Banner size changed', s)],

    [InterstitialAdPluginEvents.Loaded, i => { interstitialReady = true; interstitialFailCount = 0; recordEvent('Interstitial loaded', i); }],
    [InterstitialAdPluginEvents.Showed, i => recordEvent('Interstitial showed', i)],
    [InterstitialAdPluginEvents.Dismissed, i => {
      interstitialReady = false;
      recordEvent('Interstitial dismissed', i);
      if (interstitialDismissResolve) interstitialDismissResolve('dismissed');
      setTimeout(() => { if (initialized) void loadInterstitial(); }, 500);
    }],
    [InterstitialAdPluginEvents.FailedToLoad, e => {
      interstitialReady = false;
      interstitialFailCount += 1;
      lastError = 'Interstitial failed to load: ' + (e?.message || JSON.stringify(e));
      recordEvent('Interstitial failed to load', e);
      setTimeout(() => { if (initialized) void loadInterstitial(); }, retryDelay(interstitialFailCount));
    }],
    [InterstitialAdPluginEvents.FailedToShow, e => {
      interstitialReady = false;
      lastError = 'Interstitial failed to show: ' + (e?.message || JSON.stringify(e));
      recordEvent('Interstitial failed to show', e);
      if (interstitialDismissResolve) interstitialDismissResolve('failed');
    }],

    [RewardAdPluginEvents.Loaded, i => { rewardedReady = true; rewardedFailCount = 0; recordEvent('Rewarded loaded', i); }],
    [RewardAdPluginEvents.Showed, i => recordEvent('Rewarded showed', i)],
    [RewardAdPluginEvents.Dismissed, i => {
      rewardedReady = false;
      recordEvent('Rewarded dismissed', i);
      if (rewardedDismissResolve) rewardedDismissResolve('dismissed');
      setTimeout(() => { if (initialized) void loadRewarded(); }, 500);
    }],
    [RewardAdPluginEvents.Rewarded, i => { rewardEarnedDuringShow = true; recordEvent('Reward earned', i); }],
    [RewardAdPluginEvents.FailedToLoad, e => {
      rewardedReady = false;
      rewardedFailCount += 1;
      lastError = 'Rewarded failed to load: ' + (e?.message || JSON.stringify(e));
      recordEvent('Rewarded failed to load', e);
      setTimeout(() => { if (initialized) void loadRewarded(); }, retryDelay(rewardedFailCount));
    }],
    [RewardAdPluginEvents.FailedToShow, e => {
      rewardedReady = false;
      lastError = 'Rewarded failed to show: ' + (e?.message || JSON.stringify(e));
      recordEvent('Rewarded failed to show', e);
      if (rewardedDismissResolve) rewardedDismissResolve('failed');
    }],
  ];
  for (const [eventName, callback] of registrations) {
    if (!eventName) continue;
    try { await AdMob.addListener(eventName, callback); }
    catch (e) { log('Listener registration failed:', eventName, e); }
  }
}

async function loadInterstitial() {
  if (!initialized || !consentAllowsAds) return false;
  if (interstitialReady) return true;
  if (interstitialLoadPromise) return interstitialLoadPromise;

  interstitialLoadPromise = (async () => {
    try {
      lastStatus = 'Loading interstitial';
      await withTimeout(AdMob.prepareInterstitial({
        adId: AD_UNITS.interstitial,
        isTesting: TEST_MODE,
      }), 25000, 'Interstitial load');
      interstitialReady = true;
      interstitialFailCount = 0;
      lastStatus = 'Interstitial loaded';
      log('Interstitial loaded');
      return true;
    } catch (error) {
      interstitialReady = false;
      fail('Interstitial load failed', error);
      return false;
    } finally {
      interstitialLoadPromise = null;
    }
  })();

  return interstitialLoadPromise;
}

async function loadRewarded() {
  if (!initialized || !consentAllowsAds) return false;
  if (rewardedReady) return true;
  if (rewardedLoadPromise) return rewardedLoadPromise;

  rewardedLoadPromise = (async () => {
    try {
      lastStatus = 'Loading rewarded ad';
      recordEvent('Rewarded load requested', { adUnitId: AD_UNITS.rewarded });
      await withTimeout(AdMob.prepareRewardVideoAd({
        adId: AD_UNITS.rewarded,
        isTesting: TEST_MODE,
      }), 25000, 'Rewarded load');
      rewardedReady = true;
      rewardedFailCount = 0;
      lastStatus = 'Rewarded loaded';
      recordEvent('Rewarded prepare completed');
      return true;
    } catch (error) {
      rewardedReady = false;
      fail('Rewarded load failed', error);
      recordEvent('Rewarded load error', error?.message || String(error));
      return false;
    } finally {
      rewardedLoadPromise = null;
    }
  })();

  return rewardedLoadPromise;
}

// Banner işlemleri sırayla çalışır. Her native çağrının zaman aşımı vardır,
// böylece takılan bir banner çağrısı kuyruğu (ve tam ekran reklamları) kilitleyemez.
function setBanner(visible) {
  bannerWanted = !!visible;
  if (!initialized || !consentAllowsAds) return Promise.resolve(false);

  const operation = async () => {
    if (!initialized || !consentAllowsAds) return false;

    while (bannerVisible !== bannerWanted) {
      const target = bannerWanted;
      try {
        if (target) {
          await withTimeout(AdMob.showBanner({
            adId: AD_UNITS.banner,
            adSize: BannerAdSize.ADAPTIVE_BANNER,
            position: BannerAdPosition.BOTTOM_CENTER,
            margin: 0,
            isTesting: TEST_MODE,
          }), 10000, 'Banner show');
        } else {
          await withTimeout(AdMob.hideBanner(), 5000, 'Banner hide');
        }

        bannerVisible = target;
        setBannerClass(target);
        lastStatus = target ? 'Banner show requested' : 'Banner hidden';
        log(lastStatus);
      } catch (error) {
        bannerVisible = false;
        setBannerClass(false);
        fail('Banner operation failed', error);
        return false;
      }
    }
    return bannerVisible;
  };

  const next = bannerQueue.then(operation, operation);
  bannerQueue = next.then(() => undefined, () => undefined);
  return next;
}

// Tam ekran reklamdan önce banner'ı gizle, ama en fazla 1,2 sn bekle.
async function hideBannerBeforeFullscreen() {
  try { await Promise.race([setBanner(false), sleep(1200)]); } catch (e) { /* yoksay */ }
}

async function init() {
  if (!isNative()) {
    lastError = 'Native Capacitor Android app not detected.';
    lastStatus = 'Not native';
    console.warn('[Gem Rush AdMob]', lastError);
    return false;
  }

  if (initialized) {
    void setBanner(isBannerScreen(currentScreen));
    return true;
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      lastStatus = 'Requesting consent information';
      let consent = null;
      try {
        consent = await withTimeout(AdMob.requestConsentInfo(), 20000, 'Consent info');
        if (consent.isConsentFormAvailable && consent.status === AdmobConsentStatus.REQUIRED) {
          lastStatus = 'Showing consent form';
          consent = await AdMob.showConsentForm();
        }
      } catch (consentError) {
        // Onay bilgisi alınamazsa (ör. ağ gecikmesi) SDK'yı yine de başlat;
        // SDK, onay gerektiren bölgelerde kişiselleştirilmiş reklamı kendisi kısıtlar.
        fail('Consent step failed (continuing)', consentError);
        consent = null;
      }

      consentSnapshot = consent;
      consentAllowsAds = consent ? consentCanRequestAds(consent) : true;
      privacyOptionsRequired = consent?.privacyOptionsRequirementStatus === 'REQUIRED';
      log('Consent result:', consent, 'allowsAds:', consentAllowsAds);

      if (!consentAllowsAds) {
        lastError = 'UMP returned canRequestAds=false. No ad request is allowed yet.';
        lastStatus = 'Consent blocks ad requests';
        console.warn('[Gem Rush AdMob]', lastError);
        return false;
      }

      await installAdListeners();
      lastStatus = 'Initializing Google Mobile Ads SDK';
      await withTimeout(AdMob.initialize(), 20000, 'SDK initialize');
      initialized = true;
      initRetryCount = 0;
      lastError = '';
      lastStatus = 'SDK initialized';
      log('SDK initialized. Test mode:', TEST_MODE, 'Units:', AD_UNITS);

      void loadInterstitial();
      void loadRewarded();
      void setBanner(isBannerScreen(currentScreen));
      return true;
    } catch (error) {
      initialized = false;
      fail('SDK initialization failed', error);

      if (initRetryCount < 5) {
        const delay = 1500 * (initRetryCount + 1);
        initRetryCount += 1;
        log(`Retrying SDK initialization (${initRetryCount}/5) in ${delay} ms`);
        setTimeout(() => {
          if (!initialized && !initPromise) void init();
        }, delay);
      }
      return false;
    }
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

function setScreen(screen) {
  currentScreen = screen;
  void setBanner(isBannerScreen(screen));
}

async function showInterstitial() {
  if (!initialized) await init();
  if (!initialized || !consentAllowsAds || interstitialBusy) return false;
  interstitialBusy = true;
  recordEvent('Interstitial show requested', { ready: interstitialReady, screen: currentScreen });

  try {
    await hideBannerBeforeFullscreen();
    if (!interstitialReady && !(await loadInterstitial())) return false;

    lastStatus = 'Showing interstitial';
    const outcome = await new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(safety);
        interstitialDismissResolve = null;
        resolve(value);
      };
      // Reklam kapanınca (Dismissed olayı) veya gösterilemezse biter.
      interstitialDismissResolve = finish;
      const safety = setTimeout(() => finish('timeout'), 90000);
      AdMob.showInterstitial().then(
        () => { interstitialReady = false; recordEvent('Interstitial show call completed'); },
        error => { fail('Interstitial show failed', error); finish('error'); }
      );
    });

    interstitialReady = false;
    recordEvent('Interstitial finished', outcome);
    return outcome === 'dismissed';
  } catch (error) {
    interstitialReady = false;
    fail('Interstitial show failed', error);
    recordEvent('Interstitial show error', error?.message || String(error));
    return false;
  } finally {
    interstitialBusy = false;
    setTimeout(() => { if (initialized) void loadInterstitial(); }, 800);
    if (isBannerScreen(currentScreen)) void setBanner(true);
  }
}

async function showRewarded() {
  if (!initialized) await init();
  if (!initialized || !consentAllowsAds || rewardedBusy) return false;
  rewardedBusy = true;
  rewardEarnedDuringShow = false;
  recordEvent('Rewarded show requested', { ready: rewardedReady, screen: currentScreen });

  try {
    await hideBannerBeforeFullscreen();
    if (!rewardedReady && !(await loadRewarded())) return false;

    lastStatus = 'Showing rewarded ad';
    const outcome = await new Promise(resolve => {
      let done = false;
      let graceTimer = null;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(safety);
        clearTimeout(graceTimer);
        rewardedDismissResolve = null;
        resolve(value);
      };
      // Reklam kapanınca (Dismissed olayı) veya gösterilemezse biter.
      rewardedDismissResolve = finish;
      const safety = setTimeout(() => finish('timeout'), 180000);
      AdMob.showRewardVideoAd().then(
        result => {
          // Eklenti ödül kazanılınca sonuç döndürür; ödül nesnesi varsa ödül say.
          if (result && (result.amount !== undefined || result.type !== undefined)) rewardEarnedDuringShow = true;
          // Dismissed olayı gelmezse reklam ekranını sonsuza dek bekleme.
          graceTimer = setTimeout(() => finish('grace'), 20000);
        },
        error => { fail('Rewarded show failed', error); finish('error'); }
      );
    });

    rewardedReady = false;
    // Ödül yalnızca Rewarded olayı veya ödül nesnesi geldiyse verilir;
    // reklam sadece açıldı ya da kapatıldı diye ödül verilmez.
    const earned = rewardEarnedDuringShow;
    lastStatus = earned ? 'Reward earned' : 'Rewarded ad closed without reward';
    recordEvent(earned ? 'Reward confirmed' : 'Reward not confirmed', outcome);
    return earned;
  } catch (error) {
    rewardedReady = false;
    fail('Rewarded show failed', error);
    recordEvent('Rewarded show error', error?.message || String(error));
    return false;
  } finally {
    rewardedBusy = false;
    setTimeout(() => { if (initialized) void loadRewarded(); }, 800);
    if (isBannerScreen(currentScreen)) void setBanner(true);
  }
}

window.GemRushAdMob = {
  init,
  isNative,
  isReady: () => initialized && consentAllowsAds,
  setScreen,
  showInterstitial,
  showRewarded,
  getDebugState: () => ({
    native: isNative(),
    initialized,
    consentAllowsAds,
    consent: consentSnapshot,
    testMode: TEST_MODE,
    adUnits: AD_UNITS,
    status: lastStatus,
    lastError,
    bannerVisible,
    bannerWanted,
    interstitialReady,
    interstitialLoading: !!interstitialLoadPromise,
    interstitialFailCount,
    rewardedReady,
    rewardedLoading: !!rewardedLoadPromise,
    rewardedFailCount,
    currentScreen,
    recentEvents: recentEvents.slice(-12),
    listenersInstalled,
  }),
  privacyOptionsRequired: () => privacyOptionsRequired,
  showPrivacyOptionsForm: async () => {
    if (!privacyOptionsRequired) return false;
    try {
      await AdMob.showPrivacyOptionsForm();
      return true;
    } catch (error) {
      fail('Privacy options form failed', error);
      return false;
    }
  },
};

// Köprü yüklenir yüklenmez başlat; HTML'deki Ads.init() aynı işlemi paylaşır.
if (isNative()) setTimeout(() => { void init(); }, 0);

// Android ön plana dönünce native görünüm hazırsa yeniden dene.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isNative() && !initialized && !initPromise) {
    setTimeout(() => {
      if (!document.hidden && !initialized && !initPromise) void init();
    }, 800);
  }
});
