import { Capacitor } from '@capacitor/core';
import {
  AdMob,
  AdmobConsentStatus,
  BannerAdPosition,
  BannerAdSize,
} from '@capacitor-community/admob';

// Keep test ads enabled until all three formats are confirmed on a real device.
const TEST_MODE = true;
const LIVE_AD_UNITS = {
  banner: 'ca-app-pub-3173758070343843/8727460148',
  interstitial: 'ca-app-pub-3173758070343843/6264627536',
  rewarded: 'ca-app-pub-3173758070343843/7985224111',
};
// Google's official Android demo units. These reliably return test creatives.
const TEST_AD_UNITS = {
  banner: 'ca-app-pub-3940256099942544/6300978111',
  interstitial: 'ca-app-pub-3940256099942544/1033173712',
  rewarded: 'ca-app-pub-3940256099942544/5224354917',
};
const AD_UNITS = TEST_MODE ? TEST_AD_UNITS : LIVE_AD_UNITS;

let initialized = false;
let consentAllowsAds = false;
let privacyOptionsRequired = false;
let bannerVisible = false;
let bannerBusy = false;
let bannerWanted = false;
let interstitialReady = false;
let currentScreen = 'menu';
let interstitialBusy = false;
let rewardedBusy = false;
let lastError = '';
let consentSnapshot = null;

const isNative = () => Capacitor.isNativePlatform();
const isBannerScreen = screen => ['menu', 'shop', 'pg', 'end'].includes(screen);
function setBannerClass(visible) {
  const app = document.getElementById('app');
  if (app) app.classList.toggle('ad-banner-visible', !!visible);
}
function reportError(where, error) {
  lastError = `${where}: ${error?.message || error || 'unknown error'}`;
  console.error('[Gem Rush AdMob]', lastError, error);
}

async function loadInterstitial() {
  if (!initialized || !consentAllowsAds) return false;
  try {
    await AdMob.prepareInterstitial({ adId: AD_UNITS.interstitial, isTesting: TEST_MODE, immersiveMode: true });
    interstitialReady = true;
    console.info('[Gem Rush AdMob] Interstitial loaded');
    return true;
  } catch (error) {
    interstitialReady = false;
    reportError('Interstitial load failed', error);
    return false;
  }
}

async function init() {
  if (!isNative()) {
    lastError = 'AdMob only works in the native Android/iOS app, not a browser preview.';
    console.warn('[Gem Rush AdMob]', lastError);
    return false;
  }
  if (initialized) return true;
  try {
    let consent = await AdMob.requestConsentInfo();
    if (consent.isConsentFormAvailable && consent.status === AdmobConsentStatus.REQUIRED) {
      consent = await AdMob.showConsentForm();
    }
    consentSnapshot = consent;
    consentAllowsAds = !!consent.canRequestAds;
    privacyOptionsRequired = consent.privacyOptionsRequirementStatus === 'REQUIRED';
    console.info('[Gem Rush AdMob] Consent result:', consent);
    if (!consentAllowsAds) {
      lastError = 'Consent SDK says canRequestAds=false; no ad request was sent.';
      console.warn('[Gem Rush AdMob]', lastError);
      return false;
    }
    await AdMob.initialize();
    initialized = true;
    console.info('[Gem Rush AdMob] SDK initialized; test mode:', TEST_MODE);
    void loadInterstitial();
    // Apply the screen selected by the game while initialization was running.
    void setBanner(isBannerScreen(currentScreen));
    return true;
  } catch (error) {
    initialized = false;
    consentAllowsAds = false;
    reportError('Initialization failed', error);
    return false;
  }
}

async function setBanner(visible) {
  bannerWanted = !!visible;
  if (!initialized || !consentAllowsAds || bannerBusy) return;
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
      console.info('[Gem Rush AdMob] Banner state:', target ? 'shown' : 'hidden');
    }
  } catch (error) {
    bannerVisible = false;
    setBannerClass(false);
    reportError('Banner operation failed', error);
  } finally {
    bannerBusy = false;
    if (initialized && consentAllowsAds && bannerVisible !== bannerWanted) void setBanner(bannerWanted);
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
    await setBanner(false);
    if (!interstitialReady && !(await loadInterstitial())) return false;
    await AdMob.showInterstitial();
    interstitialReady = false;
    void loadInterstitial();
    return true;
  } catch (error) {
    interstitialReady = false;
    reportError('Interstitial show failed', error);
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
    const reward = await AdMob.showRewardVideoAd();
    return !!reward;
  } catch (error) {
    reportError('Rewarded ad failed', error);
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
  privacyOptionsRequired: () => privacyOptionsRequired,
  getDebugState: () => ({ native: isNative(), initialized, consentAllowsAds, consent: consentSnapshot, testMode: TEST_MODE, adUnits: AD_UNITS, lastError }),
  showPrivacyOptionsForm: async () => {
    if (!initialized || !privacyOptionsRequired) return false;
    try { await AdMob.showPrivacyOptionsForm(); return true; }
    catch (error) { reportError('Privacy options form failed', error); return false; }
  },
};
