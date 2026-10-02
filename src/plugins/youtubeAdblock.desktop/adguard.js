/* eslint-disable */

/**
 * This file is part of AdGuard's Block YouTube Ads (https://github.com/AdguardTeam/BlockYouTubeAdsShortcut).
 *
 * Copyright (C) AdGuard Team
 *
 * AdGuard's Block YouTube Ads is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * AdGuard's Block YouTube Ads is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with AdGuard's Block YouTube Ads.  If not, see <http://www.gnu.org/licenses/>.
 */
(() => {
    if (window.adguardInjected) return;
    window.adguardInjected = true;

    const hiddenCSS = [
        "#__ffYoutube1",
        "#__ffYoutube2",
        "#__ffYoutube3",
        "#__ffYoutube4",
        "#feed-pyv-container",
        "#feedmodule-PRO",
        "#homepage-chrome-side-promo",
        "#merch-shelf",
        "#offer-module",
        '#pla-shelf > ytd-pla-shelf-renderer[class="style-scope ytd-watch"]',
        "#pla-shelf",
        "#premium-yva",
        "#promo-info",
        "#promo-list",
        "#promotion-shelf",
        "#related > ytd-watch-next-secondary-results-renderer > #items > ytd-compact-promoted-video-renderer.ytd-watch-next-secondary-results-renderer",
        "#search-pva",
        "#shelf-pyv-container",
        "#video-masthead",
        "#watch-branded-actions",
        "#watch-buy-urls",
        "#watch-channel-brand-div",
        "#watch7-branded-banner",
        "#YtKevlarVisibilityIdentifier",
        "#YtSparklesVisibilityIdentifier",
        ".carousel-offer-url-container",
        ".companion-ad-container",
        ".GoogleActiveViewElement",
        '.list-view[style="margin: 7px 0pt;"]',
        ".promoted-sparkles-text-search-root-container",
        ".promoted-videos",
        ".searchView.list-view",
        ".sparkles-light-cta",
        ".watch-extra-info-column",
        ".watch-extra-info-right",
        ".ytd-carousel-ad-renderer",
        ".ytd-compact-promoted-video-renderer",
        ".ytd-companion-slot-renderer",
        ".ytd-merch-shelf-renderer",
        ".ytd-player-legacy-desktop-watch-ads-renderer",
        ".ytd-promoted-sparkles-text-search-renderer",
        ".ytd-promoted-video-renderer",
        ".ytd-search-pyv-renderer",
        ".ytd-video-masthead-ad-v3-renderer",
        ".ytp-ad-action-interstitial-background-container",
        ".ytp-ad-action-interstitial-slot",
        ".ytp-ad-image-overlay",
        ".ytp-ad-overlay-container",
        ".ytp-ad-progress",
        ".ytp-ad-progress-list",
        '[class*="ytd-display-ad-"]',
        '[layout*="display-ad-"]',
        'a[href^="http://www.youtube.com/cthru?"]',
        'a[href^="https://www.youtube.com/cthru?"]',
        "ytd-action-companion-ad-renderer",
        "ytd-banner-promo-renderer",
        "ytd-compact-promoted-video-renderer",
        "ytd-companion-slot-renderer",
        "ytd-display-ad-renderer",
        "ytd-promoted-sparkles-text-search-renderer",
        "ytd-promoted-sparkles-web-renderer",
        "ytd-search-pyv-renderer",
        "ytd-single-option-survey-renderer",
        "ytd-video-masthead-ad-advertiser-info-renderer",
        "ytd-video-masthead-ad-v3-renderer",
        "YTM-PROMOTED-VIDEO-RENDERER",
    ];
    /**
     * Adds CSS to the page
     */
    const hideElements = () => {
        const selectors = hiddenCSS;
        if (!selectors) {
            return;
        }
        const rule = selectors.join(", ") + " { display: none!important; }";
        const style = document.createElement("style");
        style.textContent = rule;
        document.head.appendChild(style);
    };
    /**
     * Calls the "callback" function on every DOM change, but not for the tracked events
     * @param {Function} callback callback function
     */
    const observeDomChanges = callback => {
        const domMutationObserver = new MutationObserver(mutations => {
            callback(mutations);
        });
        domMutationObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
    };
    /**
     * This function is supposed to be called on every DOM change
     */
    const hideDynamicAds = () => {
        const elements = document.querySelectorAll("#contents > ytd-rich-item-renderer ytd-display-ad-renderer");
        if (elements.length === 0) {
            return;
        }
        elements.forEach(el => {
            if (el.parentNode && el.parentNode.parentNode) {
                const parent = el.parentNode.parentNode;
                if (parent.localName === "ytd-rich-item-renderer") {
                    parent.style.display = "none";
                }
            }
        });
    };
    /**
     * This function checks if the video ads are currently running
     * and auto-clicks the skip button.
     */
    const autoSkipAds = () => {
        // If there's a video that plays the ad at this moment, scroll this ad
        if (document.querySelector(".ad-showing")) {
            const video = document.querySelector("video");
            if (video && video.duration) {
                video.currentTime = video.duration;
                // Skip button should appear after that,
                // now simply click it automatically
                setTimeout(() => {
                    const skipBtn = document.querySelector("button.ytp-ad-skip-button");
                    if (skipBtn) {
                        skipBtn.click();
                    }
                }, 100);
            }
        }
    };
    const adMetadata = { adPlacements: [], playerAds: [] };
    const stripAds = obj => {
        if (!obj || typeof obj !== "object") return obj;
        const pending = [obj];
        const seen = new WeakSet();
        while (pending.length) {
            const current = pending.pop();
            if (seen.has(current)) continue;
            seen.add(current);
            for (const key of Object.keys(current)) {
                if (Object.hasOwn(adMetadata, key)) {
                    current[key] = adMetadata[key];
                } else {
                    const value = current[key];
                    if (value && typeof value === "object") pending.push(value);
                }
            }
        }
        return obj;
    };
    const nativeJSONParse = JSON.parse;
    JSON.parse = (...args) => stripAds(nativeJSONParse(...args));
    Response.prototype.json = new Proxy(Response.prototype.json, {
        async apply(...args) {
            return stripAds(await Reflect.apply(...args));
        },
    });
    // Applies CSS that hides YouTube ad elements
    hideElements();
    // Some changes should be re-evaluated on every page change
    hideDynamicAds();
    autoSkipAds();
    observeDomChanges(() => {
        hideDynamicAds();
        autoSkipAds();
    });
})();
