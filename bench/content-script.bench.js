// Benchmarks for the add-on content script (video-bg-play-content.js).
//
// The content script is a plain browser script that relies on the `window`
// and `document` globals (plus the Firefox-specific `document.wrappedJSObject`).
// To benchmark it in Node.js, the script source is compiled once into a
// function taking a minimal, EventTarget-based browser environment as
// arguments. Its internal helpers are exposed so they can be measured too.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";

const SCRIPT_PATH = fileURLToPath(
  new URL("../video-bg-play-content.js", import.meta.url),
);
const SOURCE = readFileSync(SCRIPT_PATH, "utf8");

const createContentScript = new Function(
  "window",
  "document",
  "KeyboardEvent",
  `${SOURCE}
return { pressKey, sendKeyEvent, loop, getRandomInt,
         IS_YOUTUBE, IS_MOBILE_YOUTUBE, IS_DESKTOP_YOUTUBE, IS_VIMEO, IS_ANDROID };`,
);

class FakeKeyboardEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.keyCode = init.keyCode;
    this.which = init.which;
  }
}

const ANDROID_UA =
  "Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0";
const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

// Timers are recorded but never fired so that the activity loop does not
// keep running in the background.
function createEnvironment(hostname, userAgent) {
  const window = new EventTarget();
  window.location = { hostname };
  window.navigator = { userAgent };
  window.timers = [];
  window.setTimeout = (callback, delay) => {
    window.timers.push({ callback, delay });
    return window.timers.length;
  };
  const document = new EventTarget();
  document.wrappedJSObject = {};
  return { window, document };
}

function runContentScript(hostname, userAgent) {
  const { window, document } = createEnvironment(hostname, userAgent);
  return createContentScript(window, document, FakeKeyboardEvent);
}

const SITES = [
  ["www.youtube.com", DESKTOP_UA],
  ["m.youtube.com", ANDROID_UA],
  ["www.youtube-nocookie.com", DESKTOP_UA],
  ["vimeo.com", ANDROID_UA],
  ["player.vimeo.com", DESKTOP_UA],
  ["example.com", ANDROID_UA],
];

describe("content script injection", () => {
  test("per site", async ({ bench }) => {
    await bench.compare(
      ...SITES.map(([hostname, userAgent]) => {
        const platform = userAgent === ANDROID_UA ? "android" : "desktop";
        return bench(`inject on ${hostname} (${platform}) x100`, () => {
          for (let i = 0; i < 100; i++) {
            runContentScript(hostname, userAgent);
          }
        });
      }),
    );
  });

  test("all sites", async ({ bench }) => {
    await bench("inject on all supported sites x100", () => {
      for (let i = 0; i < 100; i++) {
        for (const [hostname, userAgent] of SITES) {
          runContentScript(hostname, userAgent);
        }
      }
    }).run();
  });
});

describe("event blocking", () => {
  test("blocked events", async ({ bench }) => {
    // Vimeo installs both the visibilitychange and fullscreenchange blockers.
    const { window, document } = createEnvironment("vimeo.com", ANDROID_UA);
    createContentScript(window, document, FakeKeyboardEvent);
    // Page listeners that should never be reached once the add-on is active.
    let leaked = 0;
    window.addEventListener("visibilitychange", () => leaked++);
    window.addEventListener("fullscreenchange", () => leaked++);

    await bench.compare(
      bench("block 1000 visibilitychange events", () => {
        for (let i = 0; i < 1000; i++) {
          window.dispatchEvent(new Event("visibilitychange"));
        }
        if (leaked !== 0) throw new Error("visibilitychange was not blocked");
      }),
      bench("block 1000 fullscreenchange events", () => {
        for (let i = 0; i < 1000; i++) {
          window.dispatchEvent(new Event("fullscreenchange"));
        }
        if (leaked !== 0) throw new Error("fullscreenchange was not blocked");
      }),
    );
  });
});

describe("user activity simulation", () => {
  test("activity helpers", async ({ bench }) => {
    const { window, document } = createEnvironment(
      "www.youtube.com",
      DESKTOP_UA,
    );
    const script = createContentScript(window, document, FakeKeyboardEvent);
    let received = 0;
    document.addEventListener("keydown", () => received++);
    document.addEventListener("keyup", () => received++);

    await bench.compare(
      bench("pressKey x1000", () => {
        for (let i = 0; i < 1000; i++) {
          script.pressKey();
        }
      }),
      bench("schedule activity loop x1000", () => {
        window.timers.length = 0;
        for (let i = 0; i < 1000; i++) {
          script.loop(script.pressKey, 60 * 1000, 10 * 1000);
        }
      }),
      bench("run scheduled activity ticks x100", () => {
        window.timers.length = 0;
        script.loop(script.pressKey, 60 * 1000, 10 * 1000);
        // Each tick fires the key events and schedules the next one.
        for (let i = 0; i < 100; i++) {
          window.timers[i].callback();
        }
      }),
      bench("getRandomInt x10000", () => {
        let acc = 0;
        for (let i = 0; i < 10000; i++) {
          acc += script.getRandomInt(-5000, 5000);
        }
        return acc;
      }),
    );
    if (received === 0) throw new Error("no key events were dispatched");
  });
});
