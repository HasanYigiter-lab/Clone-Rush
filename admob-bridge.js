import { Capacitor } from '@capacitor/core';
import { AdMob, AdmobConsentStatus, BannerAdPosition, BannerAdSize, BannerAdPluginEvents, InterstitialAdPluginEvents, RewardAdPluginEvents } from '@capacitor-community/admob';

// Keep Google demo ad units enabled until all formats are verified on a real device.
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
let interstitialBusy = false;
let rewardedBusy = false;
let currentScreen = 'menu';
let lastError = '';
let lastStatus = 'Not initialized';
let listenersInstalled = false;
const recentEvents = [];
function recordEvent(name, detail = '') {
  const item = { time: new Date().toLocaleTimeString(), name, detail: detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '' };
  recentEvents.push(item);
  if (recentEvents.length > 20) recentEvents.shift();
  lastStatus = name;
  log(name, detail);
}
async function installAdListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  const registrations = [
    [BannerAdPluginEvents.Loaded, () => recordEvent('Banner loaded')],
    [BannerAdPluginEvents.FailedToLoad, e => { lastError = 'Banner failed to load: ' + (e?.message || JSON.stringify(e)); recordEvent('Banner failed to load', e); }],
    [BannerAdPluginEvents.SizeChanged, s => recordEvent('Banner size changed', s)],
    [InterstitialAdPluginEvents.Loaded, i => recordEvent('Interstitial loaded', i)],
    [InterstitialAdPluginEvents.FailedToLoad, e => { lastError = 'Interstitial failed to load: ' + (e?.message || JSON.stringify(e)); recordEvent('Interstitial failed to load', e); }],
    [InterstitialAdPluginEvents.FailedToShow, e => { lastError = 'Interstitial failed to show: ' + (e?.message || JSON.stringify(e)); recordEvent('Interstitial failed to show', e); }],
    [RewardAdPluginEvents.Loaded, i => recordEvent('Rewarded loaded', i)],
    [RewardAdPluginEvents.FailedToLoad, e => { lastError = 'Rewarded failed to load: ' + (e?.message || JSON.stringify(e)); recordEvent('Rewarded failed to load', e); }],
    [RewardAdPluginEvents.FailedToShow, e => { lastError = 'Rewarded failed to show: ' + (e?.message || JSON.stringify(e)); recordEvent('Rewarded failed to show', e); }],
  ];
  for (const [eventName, callback] of registrations) {
    try { await AdMob.addListener(eventName, callback); }
    catch (e) { log('Listener registration failed:', eventName, e); }
  }
}

const isNative = () => Capacitor.isNativePlatform();
const isBannerScreen = screen => ['menu', 'shop', 'pg', 'end'].includes(screen);

function log(...args) {
  console.info('[Gem Rush AdMob]', ...args);
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

async function loadInterstitial() {
  if (!initialized || !consentAllowsAds) return false;
  if (interstitialReady) return true;
  if (interstitialLoadPromise) return interstitialLoadPromise;

  interstitialLoadPromise = (async () => {
    try {
      lastStatus = 'Loading interstitial';
      await AdMob.prepareInterstitial({
        adId: AD_UNITS.interstitial,
        isTesting: TEST_MODE,
        immersiveMode: true,
      });
      interstitialReady = true;
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

// Serialize native banner operations. This prevents a show request racing a hide request.
function setBanner(visible) {
  bannerWanted = !!visible;
  if (!initialized || !consentAllowsAds) return Promise.resolve(false);

  const operation = async () => {
    if (!initialized || !consentAllowsAds) return false;

    while (bannerVisible !== bannerWanted) {
      const target = bannerWanted;
      try {
        if (target) {
          await AdMob.showBanner({
            adId: AD_UNITS.banner,
            adSize: BannerAdSize.ADAPTIVE_BANNER,
            position: BannerAdPosition.BOTTOM_CENTER,
            margin: 0,
            isTesting: TEST_MODE,
          });
        } else {
          await AdMob.hideBanner();
        }

        bannerVisible = target;
        setBannerClass(target);
        lastStatus = target ? 'Banner show requested' : 'Banner hidden';
        log(lastStatus);
      } catch (error) {
        bannerVisible = false;
        setBannerClass(false);
        fail('Banner operation failed', error);
        // Do not immediately retry a failed banner forever. A later screen change can retry.
        return false;
      }
    }
    return bannerVisible;
  };

  const next = bannerQueue.then(operation, operation);
  bannerQueue = next.then(() => undefined, () => undefined);
  return next;
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
      let consent = await AdMob.requestConsentInfo();

      if (consent.isConsentFormAvailable && consent.status === AdmobConsentStatus.REQUIRED) {
        lastStatus = 'Showing consent form';
        consent = await AdMob.showConsentForm();
      }

      consentSnapshot = consent;
      consentAllowsAds = !!consent.canRequestAds;
      privacyOptionsRequired = consent.privacyOptionsRequirementStatus === 'REQUIRED';
      log('Consent result:', consent);

      if (!consentAllowsAds) {
        lastError = 'UMP returned canRequestAds=false. No ad request is allowed yet.';
        lastStatus = 'Consent blocks ad requests';
        console.warn('[Gem Rush AdMob]', lastError);
        return false;
      }

      await installAdListeners();
      lastStatus = 'Initializing Google Mobile Ads SDK';
      await AdMob.initialize();
      initialized = true;
      initRetryCount = 0;
      lastError = '';
      lastStatus = 'SDK initialized';
      log('SDK initialized. Test mode:', TEST_MODE, 'Units:', AD_UNITS);

      // Start loading the full-screen format independently of the banner.
      void loadInterstitial();
      void setBanner(isBannerScreen(currentScreen));
      return true;
    } catch (error) {
      initialized = false;
      fail('SDK initialization failed', error);

      // Android's native content view can become available shortly after WebView startup.
      if (initRetryCount < 3) {
        const delay = 1500 * (initRetryCount + 1);
        initRetryCount += 1;
        log(`Retrying SDK initialization (${initRetryCount}/3) in ${delay} ms`);
        setTimeout(() => {
          if (!document.hidden && !initialized) void init();
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
  if (!initialized || !consentAllowsAds || interstitialBusy) return false;
  interstitialBusy = true;

  try {
    // Wait for the native banner hide operation to finish before opening full-screen ad.
    await setBanner(false);
    if (!interstitialReady && !(await loadInterstitial())) return false;

    await AdMob.showInterstitial({ adId: AD_UNITS.interstitial });
    interstitialReady = false;
    lastStatus = 'Interstitial shown';
    void loadInterstitial();
    return true;
  } catch (error) {
    interstitialReady = false;
    fail('Interstitial show failed', error);
    void loadInterstitial();
    return false;
  } finally {
    interstitialBusy = false;
    if (isBannerScreen(currentScreen)) void setBanner(true);
  }
}

async function showRewarded() {
  if (!initialized || !consentAllowsAds || rewardedBusy) return false;
  rewardedBusy = true;

  try {
    await setBanner(false);
    lastStatus = 'Loading rewarded ad';
    await AdMob.prepareRewardVideoAd({
      adId: AD_UNITS.rewarded,
      isTesting: TEST_MODE,
      immersiveMode: true,
    });
    const reward = await AdMob.showRewardVideoAd({ adId: AD_UNITS.rewarded });
    lastStatus = 'Rewarded ad completed';
    return !!reward;
  } catch (error) {
    fail('Rewarded ad failed', error);
    return false;
  } finally {
    rewardedBusy = false;
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

// Retry initialization when Android returns to the foreground after its native view is ready.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isNative() && !initialized && !initPromise) {
    setTimeout(() => {
      if (!document.hidden && !initialized) void init();
    }, 800);
  }
});
