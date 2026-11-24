import { Capacitor } from '@capacitor/core';
import { AdMob, AdmobConsentStatus, BannerAdPosition, BannerAdSize } from '@capacitor-community/admob';

// Google demo units for Android. Keep TEST_MODE true until all formats are verified.
const TEST_MODE = true;
const TEST_AD_UNITS = {
  banner: 'ca-app-pub-3940256099942544/6300978111',
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
let bannerBusy = false;
let interstitialReady = false;
let interstitialBusy = false;
let rewardedBusy = false;
let currentScreen = 'menu';
let lastError = '';
let lastStatus = 'Not initialized';

const isNative = () => Capacitor.isNativePlatform();
const isBannerScreen = screen => ['menu', 'shop', 'pg', 'end'].includes(screen);
function log(...args) { console.info('[Gem Rush AdMob]', ...args); }
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
  try {
    await AdMob.prepareInterstitial({ adId: AD_UNITS.interstitial, isTesting: TEST_MODE, immersiveMode: true });
    interstitialReady = true;
    log('Interstitial test ad loaded');
    return true;
  } catch (error) {
    interstitialReady = false;
    fail('Interstitial load failed', error);
    return false;
  }
}

async function setBanner(visible) {
  bannerWanted = !!visible;
  if (!initialized || !consentAllowsAds || bannerBusy) return false;
  bannerBusy = true;
  try {
    while (initialized && consentAllowsAds && bannerVisible !== bannerWanted) {
      const target = bannerWanted;
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
      lastStatus = target ? 'Banner requested' : 'Banner hidden';
      log(lastStatus);
    }
    return bannerVisible;
  } catch (error) {
    bannerVisible = false;
    setBannerClass(false);
    fail('Banner operation failed', error);
    return false;
  } finally {
    bannerBusy = false;
    if (initialized && consentAllowsAds && bannerVisible !== bannerWanted) void setBanner(bannerWanted);
  }
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
        lastError = 'UMP returned canRequestAds=false. No ad request is allowed until consent permits it.';
        lastStatus = 'Consent blocks ad requests';
        console.warn('[Gem Rush AdMob]', lastError);
        return false;
      }

      lastStatus = 'Initializing Google Mobile Ads SDK';
      await AdMob.initialize();
      initialized = true;
      initRetryCount = 0;
      lastError = '';
      lastStatus = 'SDK initialized; loading test ads';
      log('SDK initialized. Test mode:', TEST_MODE, 'Units:', AD_UNITS);
      // currentScreen is set by the game before/while initialization may be running.
      void setBanner(isBannerScreen(currentScreen));
      void loadInterstitial();
      return true;
    } catch (error) {
      initialized = false;
      consentAllowsAds = false;
      fail('SDK initialization failed', error);
      // Android may expose its native content/banner parent a little after the WebView starts.
      // Retry a few times instead of permanently disabling ads after the first early failure.
      if (initRetryCount < 3) {
        const delay = 1500 * (initRetryCount + 1);
        initRetryCount++;
        log(`Retrying SDK initialization (${initRetryCount}/3) in ${delay} ms`);
        setTimeout(() => { if (!document.hidden && !initialized) void init(); }, delay);
      }
      return false;
    }
  })();
  try { return await initPromise; }
  finally { initPromise = null; }
}

function setScreen(screen) {
  currentScreen = screen;
  if (initialized) void setBanner(isBannerScreen(screen));
}

async function showInterstitial() {
  if (!initialized || !consentAllowsAds || interstitialBusy) return false;
  interstitialBusy = true;
  try {
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
    await AdMob.prepareRewardVideoAd({ adId: AD_UNITS.rewarded, isTesting: TEST_MODE, immersiveMode: true });
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

// Expose state so a device-side WebView inspection can identify the exact blocker.
window.GemRushAdMob = {
  init,
  isNative,
  isReady: () => initialized && consentAllowsAds,
  setScreen,
  showInterstitial,
  showRewarded,
  getDebugState: () => ({ native: isNative(), initialized, consentAllowsAds, consent: consentSnapshot, testMode: TEST_MODE, adUnits: AD_UNITS, status: lastStatus, lastError, bannerVisible, bannerWanted, interstitialReady }),
  privacyOptionsRequired: () => privacyOptionsRequired,
  showPrivacyOptionsForm: async () => {
    if (!initialized || !privacyOptionsRequired) return false;
    try { await AdMob.showPrivacyOptionsForm(); return true; }
    catch (error) { fail('Privacy options form failed', error); return false; }
  },
};

// If Android creates its native content view late, retry when the app returns to foreground.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isNative() && !initialized) setTimeout(() => { void init(); }, 800);
});
