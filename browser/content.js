if (typeof browser === "undefined") {
    var browser = chrome;
}

document.addEventListener(
    "DOMContentLoaded",
    () => {
        window.postMessage({
            type: "vencord:meta",
            meta: {
                RENDERER_CSS_URL: browser.runtime.getURL("dist/LawyerCord.css"),
            }
        });
    },
    { once: true }
);
