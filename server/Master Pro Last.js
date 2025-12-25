// server/autoBookBMS.js
// This file wraps your autoBookBMS automation and exposes _runBookingAutomation(task).
// NOTE: keep playwright listed in package.json and installed: npm i playwright

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * autoBookBMS(options)
 * - options: see inline comments for expected fields
 */
async function autoBookBMS(options = {}) {
  console.log('***LINK FOUND NAGA, I"M running with these details' + JSON.stringify(options, null, 2));
  if (!options || !options.cinemaUrl || !options.movieId) {
    throw new Error('Missing required options: cinemaUrl and movieId');
  }

  // Config / defaults
  const THEATRE_URL = options.cinemaUrl;
  const MOVIE_ID = options.movieId;
  const SHOW_INDEX = Number(options.showIndex || 1);
  const SEAT_QUANTITY = Math.max(1, Math.min(10, Number(options.seatQuantity || 1)));
  const TARGET_SEAT = options.targetSeat || '';
  const NEXT_SEATS = Array.isArray(options.nextSeats) ? options.nextSeats : (options.nextSeats ? [options.nextSeats] : []);
  const EMAIL = options.email || '';
  const PHONE = options.phone || '';
  const GPAY_NUMBER = options.gpayNumber || PHONE || '';
  const CHROME_BINARY = options.chromeBinary || '';
  const HEADLESS = options.headless === undefined ? false : Boolean(options.headless);

  const READY_TIMEOUT_MS = (options.timeouts && options.timeouts.readyMs) || 7000;
  const GRID_SCROLL_ATTEMPTS = 6;
  const GRID_SCROLL_STEP = 100;
  const FIND_CELL_PAUSE_MS = 80;
  const CLICK_NAV_WAIT_MS = 1800;
  const SCAN_TIMEOUT = (options.timeouts && options.timeouts.scanTimeout) || 40000;

  // New: small deterministic wait after clicks to allow UI to respond.
  const WAIT_AFTER_CLICK = 75; // ms

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function randSleep(min = 30, max = 120) { return sleep(Math.floor(min + Math.random() * (max - min))); }
  function formatMs(ms) { if (ms == null) return '-'; const s = Math.floor(ms / 1000); return `${s}s ${ms % 1000}ms`; }

  let context = null;
  const timers = { start: Date.now() };
  let tmpProfileDir = null;

  try {
    // temp profile dir
    const tmpPrefix = path.join(os.tmpdir(), 'bms-chrome-');
    tmpProfileDir = fs.mkdtempSync(tmpPrefix);
    console.log('Using temporary Chrome profile dir:', tmpProfileDir);

    const launchOptions = {
      headless: HEADLESS,
      viewport: null,
      args: [
        '--start-maximized',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-plugins',
        '--remote-allow-origins=*'
      ],
    };

    if (CHROME_BINARY && fs.existsSync(CHROME_BINARY)) {
      context = await chromium.launchPersistentContext(tmpProfileDir, {
        ...launchOptions,
        executablePath: CHROME_BINARY,
        ignoreDefaultArgs: false
      });
    } else {
      context = await chromium.launchPersistentContext(tmpProfileDir, launchOptions);
    }

    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('console', msg => console.log('PAGE LOG:', msg.text ? msg.text() : msg));
    page.on('pageerror', err => console.error('PAGE ERROR:', err && err.message ? err.message : err));

    // -------------------- NEW: Resource blocking for speed (non-invasive) --------------------
    // Blocks images/fonts/known trackers but allows CSS and scripts (scripts often necessary).
    await page.route('**/*', (route) => {
      try {
        const req = route.request();
        const resourceType = req.resourceType();
        const url = req.url();
        // block images & fonts to speed up rendering (keep CSS & scripts)
        if (resourceType === 'image' || resourceType === 'font') return route.abort();
        // block common trackers / ad domains heuristically
        if (url.includes('googlesyndication') || url.includes('doubleclick') || url.includes('analytics') || url.includes('ads')) {
          return route.abort();
        }
      } catch (e) {
        // route normally if anything goes wrong
      }
      return route.continue();
    });
    // ---------------------------------------------------------------------------------------

    // --- Helpers (kept from original, with small routing to robustClick where appropriate) ---
    // New: robustClick helper — bounding-box -> locator click -> evaluate click fallback
    async function robustClick(pageOrFrame, handle, opts = {}) {
      // pageOrFrame may be a Page or Frame
      if (!handle) throw new Error('robustClick: null handle');
      const timeout = opts.timeout || 2000;
      try {
        await handle.scrollIntoViewIfNeeded().catch(() => { /* ignore */ });
      } catch (e) {}
      try {
        const box = await handle.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          // move & click via mouse for maximum compatibility
          await page.mouse.move(x, y, { steps: 4 });
          await page.mouse.click(x, y, { timeout }).catch(() => { /* ignore */ });
          await page.waitForTimeout(WAIT_AFTER_CLICK);
          return true;
        }
      } catch (e) {
        // ignore and fallback
      }
      try {
        // Try the element handle click (Playwright)
        await handle.click({ timeout, force: true }).catch(() => null);
        await page.waitForTimeout(WAIT_AFTER_CLICK);
        return true;
      } catch (e) {
        // fallback below
      }
      try {
        // try DOM evaluate click inside the element's frame context
        await (pageOrFrame).evaluate(el => { try { el.click(); } catch(e) { const ev = new MouseEvent('click', { bubbles:true, cancelable:true, composed:true }); el.dispatchEvent(ev); } }, handle).catch(() => null);
        await page.waitForTimeout(WAIT_AFTER_CLICK);
        return true;
      } catch (e) {
        return false;
      }
    }

    // Replace clickElementByBoundingBox to call robustClick (keeps existing API for other code)
    async function clickElementByBoundingBox(pageRef, elementHandle) {
      // pageRef parameter kept for compatibility
      return robustClick(pageRef, elementHandle);
    }

    async function findGridcellByMovieId(page, movieId) {
      const containerSelector = 'div.ReactVirtualized__Grid__innerScrollContainer';
      for (let attempt = 0; attempt < GRID_SCROLL_ATTEMPTS; attempt++) {
        const gridcells = await page.$$('[role="gridcell"]');
        for (const cell of gridcells) {
          try {
            const href = await cell.evaluate(n => {
              const a = n.querySelector('a[href]');
              return a ? a.getAttribute('href') : null;
            });
            if (href && href.includes(movieId)) return cell;
          } catch (e) { /* ignore per-cell errors */ }
        }
        const container = await page.$(containerSelector);
        if (container) {
          try { await container.evaluate((el, step) => el.scrollBy({ top: step, behavior: 'auto' }), GRID_SCROLL_STEP); } catch (e) {}
        } else {
          await page.evaluate(step => window.scrollBy(0, step), GRID_SCROLL_STEP);
        }
        await sleep(FIND_CELL_PAUSE_MS);
      }
      const anchor = await page.$(`a[href*="${movieId}"]`);
      if (anchor) {
        const gridHandle = await anchor.evaluateHandle(a => a.closest('[role="gridcell"]') || a.parentElement);
        if (gridHandle && (await gridHandle.asElement())) return gridHandle.asElement();
      }
      return null;
    }

    async function clickShowtimeInGridcell(page, gridcell, showIndex) {
      const SHOW_SEL_PRIMARY = '.sc-19dkgz1-0.cVUDLk .sc-1skzbbo-0.eBWTPs, .sc-1skzbbo-0.eBWTPs';
      const SHOW_SEL_FALLBACK = 'button, a, div[role="button"], span[role="button"]';
      let showHandles = await gridcell.$$(SHOW_SEL_PRIMARY);
      if (!showHandles || showHandles.length === 0) showHandles = await gridcell.$$(SHOW_SEL_FALLBACK);
      if (!showHandles || showHandles.length === 0) throw new Error('No showtime elements found inside gridcell');
      const idx = Math.max(0, showIndex - 1);
      const chosen = showHandles[idx] || showHandles[0];
      await clickElementByBoundingBox(page, chosen);
    }

    async function waitForSeatLayoutOrPopup(page, timeoutMs = CLICK_NAV_WAIT_MS) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const url = page.url();
        if (url.includes('/seat-layout/')) return { type: 'navigation', url };
        const popup = await page.$('.sc-18zg99r-3.fQFxrM, .sc-18zg99r-5.dsUzuF, #quantity-1');
        if (popup) return { type: 'popup' };
        await sleep(150);
      }
      const urlFinal = page.url();
      if (urlFinal.includes('/seat-layout/')) return { type: 'navigation', url: urlFinal };
      return { type: 'none' };
    }

    async function handleSeatQuantityAndSelectSeats(page, seatQuantity) {
      const liSelectors = [
        `#quantity-${seatQuantity}`,
        `.sc-18zg99r-5.dsUzuF #quantity-${seatQuantity}`,
        `.sc-18zg99r-5.dsUzuF .sc-18zg99r-6.eaqRmR:nth-child(${seatQuantity})`
      ];
      let clickedQuantity = false;
      for (const sel of liSelectors) {
        const el = await page.$(sel);
        if (el) {
          try { await clickElementByBoundingBox(page, el); clickedQuantity = true; break; } catch (e) {}
        }
      }
      if (!clickedQuantity) {
        const range = await page.$('.sc-18zg99r-4.thOAQ[type="range"]');
        if (range) {
          try {
            await range.evaluate((r, val) => { r.value = String(val); r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); }, seatQuantity);
            clickedQuantity = true;
          } catch (e) {}
        }
      }

      const selectCandidates = [
        '.sc-zgl7vj-8.hpVUcY',
        '.sc-zgl7vj-7.kdBUB',
        'button:has-text("Select Seats")',
        'text="Select Seats"'
      ];
      for (const sel of selectCandidates) {
        try {
          const el = await page.$(sel);
          if (!el) continue;
          await clickElementByBoundingBox(page, el);
          return { ok: true, method: sel };
        } catch (e) {}
      }
      try {
        const fallback = await page.$('button:has-text("Select")');
        if (fallback) {
          await clickElementByBoundingBox(page, fallback);
          return { ok: true, method: 'button:has-text("Select") fallback' };
        }
      } catch (e) {}
      return { ok: false, reason: 'select-seats-not-found' };
    }

    async function injectClickBlocker(page) {
      await page.evaluate(() => {
        if (document.getElementById('__bms_click_blocker')) return;
        const d = document.createElement('div');
        d.id = '__bms_click_blocker';
        Object.assign(d.style, {
          position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
          zIndex: String(2147483647), background: 'transparent', pointerEvents: 'auto', userSelect: 'none'
        });
        const stop = e => { try { e.stopImmediatePropagation(); e.preventDefault(); } catch (err) {} };
        d.addEventListener('pointerdown', stop, true);
        d.addEventListener('mousedown', stop, true);
        d.addEventListener('click', stop, true);
        d.addEventListener('contextmenu', stop, true);
        d.addEventListener('pointerup', stop, true);
        document.documentElement.appendChild(d);
        window.__bms_blocker_toggle = (block) => { try { const el = document.getElementById('__bms_click_blocker'); if (!el) return; el.style.pointerEvents = block ? 'auto' : 'none'; } catch(e) {} };
        window.__bms_blocker_remove = () => { try { const el = document.getElementById('__bms_click_blocker'); if (el) el.remove(); delete window.__bms_blocker_toggle; delete window.__bms_blocker_remove; } catch(e) {} };
      });
    }

    async function removeInPageBlockerIfAny(page) {
      try {
        await page.evaluate(() => {
          try {
            if (window.__bms_blocker_toggle) window.__bms_blocker_toggle(false);
            if (window.__bms_blocker_remove) window.__bms_blocker_remove();
            const el = document.getElementById('__bms_click_blocker');
            if (el) el.remove();
          } catch (e) {}
        });
        await page.waitForTimeout(80);
      } catch (e) { /* ignore */ }
    }

    // Helper: find selector in page or frames
    async function findFrameWithSelector(page, selector, timeoutMs = 2000) {
      const pollMs = 200;
      const deadline = Date.now() + (timeoutMs || 2000);
      while (Date.now() < deadline) {
        try {
          const hMain = await page.$(selector);
          if (hMain) return { frame: page, handle: hMain };
          for (const f of page.frames()) {
            try {
              const h = await f.$(selector);
              if (h) return { frame: f, handle: h };
            } catch (e) { /* ignore */ }
          }
        } catch (e) {}
        await new Promise(r => setTimeout(r, pollMs));
      }
      return { frame: null, handle: null };
    }

    // --- clickPayAndAcceptTerms (robust) ---
    async function clickPayAndAcceptTerms(page) {
      // local helpers inside to be self-contained
      const sleepLocal = ms => new Promise(r => setTimeout(r, ms));
      const randSleepLocal = (min = 80, max = 220) => sleepLocal(Math.floor(min + Math.random() * (max - min)));
      async function clickElementByBoundingBoxLocal(pageLocal, handle) {
        if (!handle) throw new Error('null handle');
        try { await handle.scrollIntoViewIfNeeded(); } catch (e) {}
        const box = await handle.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          await page.mouse.move(x, y, { steps: 6 });
          await page.mouse.click(x, y);
          await sleepLocal(WAIT_AFTER_CLICK);
          return true;
        }
        try {
          await handle.evaluate(el => el.click());
          await sleepLocal(WAIT_AFTER_CLICK);
          return true;
        } catch (e) { return false; }
      }

      try { if (typeof removeInPageBlockerIfAny === 'function') await removeInPageBlockerIfAny(page); } catch (e) {}

      const payBtnClass = '.sc-zgl7vj-8.hpVUcY';
      const containerSelectors = [
        '.sc-zgl7vj-0.fvgGCE',
        '.sc-zgl7vj-0.cZKSrH',
        '.sc-1rafdbu-2.bQwReL .sc-1rafdbu-3.iEdoqk .sc-1rafdbu-5.ffDuqe .sc-zgl7vj-0.cZKSrH'
      ];
      const popupSelectors = ['.sc-zgl7vj-7.dcgLBY', '.modal, .popup, [role="dialog"]'];
      const acceptKeywords = ['accept', 'agree', 'continue', 'proceed', 'pay', 'pay now', 'ok', 'yes', 'confirm'];

      async function findAcceptCandidateInRoot(rootHandle) {
        if (!rootHandle) return null;
        try { const known = await rootHandle.$(payBtnClass); if (known) return known; } catch (e) {}
        try { const cand = await rootHandle.$('button, [role="button"], a'); if (cand) return cand; } catch (e) {}
        try {
          const all = await rootHandle.$$('*');
          const limit = Math.min(all.length, 80);
          for (let i = 0; i < limit; i++) {
            const el = all[i];
            try {
              const txt = (await (await el.getProperty('innerText')).jsonValue()) || '';
              const t = txt.trim().toLowerCase().slice(0, 60);
              if (!t) continue;
              for (const kw of acceptKeywords) if (t.includes(kw)) return el;
            } catch (e) {}
          }
        } catch (e) {}
        return null;
      }

      async function findGlobalAcceptCandidate() {
        try { const gk = await page.$(payBtnClass); if (gk) return gk; } catch (e) {}
        try {
          const list = await page.$$('button, [role="button"], a');
          const limit = Math.min(list.length, 60);
          for (let i = 0; i < limit; i++) {
            const el = list[i];
            try {
              const txt = (await (await el.getProperty('innerText')).jsonValue()) || '';
              const t = txt.trim().toLowerCase().slice(0, 60);
              if (!t) continue;
              for (const kw of acceptKeywords) if (t.includes(kw)) return el;
            } catch (e) {}
          }
        } catch (e) {}
        return null;
      }

      let clickedPay = false;
      try {
        for (const sel of containerSelectors) {
          try {
            const container = await page.$(sel);
            if (!container) continue;
            const known = await container.$(payBtnClass);
            if (known) {
              if (await clickElementByBoundingBoxLocal(page, known)) { clickedPay = true; break; }
            }
            const fallback = await container.$('button, [role="button"], a');
            if (fallback) {
              if (await clickElementByBoundingBoxLocal(page, fallback)) { clickedPay = true; break; }
            }
          } catch (e) {}
        }

        if (!clickedPay) {
          const globalKnown = await page.$(payBtnClass);
          if (globalKnown) clickedPay = await clickElementByBoundingBoxLocal(page, globalKnown);
        }

        if (!clickedPay) {
          const candidate = await findGlobalAcceptCandidate();
          if (candidate) clickedPay = await clickElementByBoundingBoxLocal(page, candidate);
        }
      } catch (e) {
        console.warn('Error while attempting to click Pay button:', e && e.message ? e.message : e);
      }

      if (!clickedPay) {
        await randSleepLocal(150, 320);
        const cur = page.url();
        if (!cur.includes('/seat-layout')) return true; // maybe already progressed
      }

      // wait for popup or navigation
      const maxWait = 7000;
      const poll = 250;
      let waited = 0;
      let popupHandle = null;
      let navigated = false;
      const startUrl = page.url();

      while (waited < maxWait) {
        try {
          const nowUrl = page.url();
          if (nowUrl !== startUrl && !nowUrl.includes('/seat-layout')) { navigated = true; break; }
        } catch (e) {}
        try {
          for (const sel of popupSelectors) {
            const h = await page.$(sel);
            if (h) { popupHandle = h; break; }
          }
          if (popupHandle) break;
        } catch (e) {}
        await sleepLocal(poll);
        waited += poll;
      }

      if (navigated) return true;

      if (popupHandle) {
        const acceptTimeout = 7000;
        const acceptPoll = 300;
        let accWait = 0;
        while (accWait < acceptTimeout) {
          try {
            const candidate = await findAcceptCandidateInRoot(popupHandle) || await findGlobalAcceptCandidate();
            if (candidate) {
              try {
                const ok = await clickElementByBoundingBoxLocal(page, candidate);
                if (ok) {
                  await randSleepLocal(220, 700);
                  const urlNow = page.url();
                  const modalStill = await page.$(popupSelectors[0]).catch(() => null);
                  if (urlNow !== startUrl || !modalStill) return true;
                }
              } catch (e) {
                try {
                  await candidate.evaluate(el => el.click());
                  await randSleepLocal(220, 700);
                  const urlNow = page.url();
                  const modalStill = await page.$(popupSelectors[0]).catch(() => null);
                  if (urlNow !== startUrl || !modalStill) return true;
                } catch (e2) {}
              }
            }
          } catch (e) {}
          await sleepLocal(acceptPoll);
          accWait += acceptPoll;
        }

        try {
          const finalBtn = await popupHandle.$('button, [role="button"], a, div');
          if (finalBtn) {
            try {
              await finalBtn.evaluate(el => el.click());
              await randSleepLocal(200, 600);
              const modalStill = await page.$(popupSelectors[0]).catch(() => null);
              if (!modalStill) return true;
            } catch (e) {}
          }
        } catch (e) {}
      }

      try {
        const nowUrl = page.url();
        if (nowUrl !== startUrl && !nowUrl.includes('/seat-layout')) return true;
        const paymentContainers = await page.$$('.sc-zgl7vj-0.fvgGCE, .sc-zgl7vj-0.cZKSrH');
        if (paymentContainers && paymentContainers.length > 0) return true;
      } catch (e) {}

      return false;
    }

    // --- clickSkipIfPresent (uses DOM path you described) ---
    async function clickSkipIfPresent(page, opts = {}) {
      const {
        containerPath = '#super-wrapper #super-container .sc-2ud7zs-0.fFKRVv',
        innerWrapper = '.sc-1nnv95q-0.eUPsDw',
        innerRow = '.sc-1nnv95q-1.hrhMgg',
        skipBtnClass = '.sc-1nnv95q-8.cYrjk',
        visibleText = 'Skip',
        waitTimeout = 1800
      } = opts;

      const result = { found: false, clicked: false, method: null, error: null };

      try {
        const preciseLocator = page.locator(`${containerPath} ${innerWrapper} ${innerRow} ${skipBtnClass}`).filter({ hasText: visibleText });

        try {
          await preciseLocator.first().waitFor({ state: 'visible', timeout: waitTimeout });
        } catch (e) { /* element may not appear - that's fine */ }

        let handle = await preciseLocator.first().elementHandle();
        if (!handle) {
          const loose = page.locator(skipBtnClass).filter({ hasText: visibleText });
          try { await loose.first().waitFor({ state: 'visible', timeout: 300 }); } catch (_) {}
          handle = await loose.first().elementHandle();
          if (!handle) { result.found = false; return result; } else result.found = true;
        } else result.found = true;

        // Try locator click
        try {
          await preciseLocator.first().click({ force: true, timeout: 2000 });
          result.clicked = true; result.method = 'locator.click(force)';
          await page.waitForTimeout(120);
          return result;
        } catch (err) { result.error = (err && err.message) ? err.message : String(err); }

        // bounding-box mouse click fallback
        try {
          const box = await handle.boundingBox();
          if (box && box.width > 0 && box.height > 0) {
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            await page.mouse.move(x, y, { steps: 6 });
            await page.mouse.click(x, y, { timeout: 2000 });
            result.clicked = true; result.method = 'mouse.boundingBox';
            await page.waitForTimeout(120);
            return result;
          }
        } catch (err) { result.error = (err && err.message) ? err.message : String(err); }

        // evaluate DOM click fallback
        try {
          const clicked = await page.evaluate((containerPath, innerWrapper, innerRow, skipBtnClass, visibleText) => {
            try {
              let el = document.querySelector(containerPath);
              if (el) el = el.querySelector(innerWrapper);
              if (el) el = el.querySelector(innerRow);
              if (el) {
                const candidates = Array.from(el.querySelectorAll(skipBtnClass) || []);
                if (candidates.length >= 2) {
                  const second = candidates[1];
                  if (second && (second.textContent || '').trim().toLowerCase().includes((visibleText||'').toLowerCase())) {
                    second.scrollIntoView({ block: 'center', inline: 'center' });
                    try { second.click(); return true; } catch(e) {}
                    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
                    second.dispatchEvent(ev);
                    return true;
                  }
                }
                for (const c of candidates) {
                  if ((c.textContent || '').trim().toLowerCase().includes((visibleText||'').toLowerCase())) {
                    c.scrollIntoView({ block: 'center', inline: 'center' });
                    try { c.click(); return true; } catch(e){}
                    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
                    c.dispatchEvent(ev);
                    return true;
                  }
                }
              }
              const global = Array.from(document.querySelectorAll(skipBtnClass || '')) || [];
              for (const g of global) {
                if ((g.textContent || '').trim().toLowerCase().includes((visibleText||'').toLowerCase())) {
                  g.scrollIntoView({ block: 'center', inline: 'center' });
                  try { g.click(); return true; } catch(e){}
                  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
                  g.dispatchEvent(ev);
                  return true;
                }
              }
              return false;
            } catch (e) { return false; }
          }, containerPath, innerWrapper, innerRow, skipBtnClass, visibleText);

          if (clicked) { result.clicked = true; result.method = 'evaluate.domClick'; await page.waitForTimeout(120); return result; }
          result.clicked = false; result.error = result.error || 'evaluate did not find clickable element';
          return result;
        } catch (err) {
          result.error = (err && err.message) ? err.message : String(err);
          return result;
        }
      } catch (outerErr) {
        result.error = (outerErr && outerErr.message) ? outerErr.message : String(outerErr);
        return result;
      }
    }

    // --- fillDeemedEmailAndPhone (single robust implementation) ---
    async function fillDeemedEmailAndPhone(page, emailVal, phoneVal, timeoutMs = 7000) {
      const emailSel = '#deemed-email';
      const phoneSel = '#deemed-mobile-number';
      const submitBtnSelectors = ['.sc-zgl7vj-7.kdBUB', 'button:has-text("Submit")', 'button:has-text("SUBMIT")', 'button:has-text("submit")'];
      try {
        const start = Date.now();
        let foundEmail = null;
        while ((Date.now() - start) < timeoutMs) {
          // look inside page & frames quickly
          const found = await findFrameWithSelector(page, emailSel, 300).catch(() => ({ frame: null, handle: null }));
          if (found && found.handle) { foundEmail = found; break; }
          await sleep(250);
        }
        if (!foundEmail) {
          // fallback: try direct page selector
          const direct = await page.$(emailSel);
          if (!direct) {
            console.warn('deemed-email input not found within timeout.');
            return { ok: false, reason: 'email-input-missing' };
          } else {
            foundEmail = { frame: page, handle: direct };
          }
        }

        // Fill email (in its frame)
        try {
          // prefer handle.fill when possible
          await foundEmail.handle.fill(String(emailVal || ''));
        } catch (e) {
          try {
            await foundEmail.frame.evaluate((sel, val) => {
              const el = document.querySelector(sel);
              if (el) { el.focus(); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
            }, emailSel, String(emailVal || ''));
          } catch (e2) {}
        }

        // Fill phone (optional)
        let phoneFound = null;
        try {
          const pf = await findFrameWithSelector(page, phoneSel, 300);
          if (pf && pf.handle) phoneFound = pf;
          else phoneFound = { frame: page, handle: await page.$(phoneSel) };
        } catch (e) { phoneFound = null; }

        if (phoneFound && phoneFound.handle) {
          try {
            await phoneFound.handle.fill(String(phoneVal || ''));
          } catch (e) {
            try {
              await (phoneFound.frame).evaluate((sel, val) => {
                const el = document.querySelector(sel);
                if (el) { el.focus(); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
              }, phoneSel, String(phoneVal || ''));
            } catch (e2) {}
          }
        } else {
          console.warn('deemed-mobile-number input not found; continuing.');
        }

        // Click Submit (try selectors across frames/pages)
        let clicked = false;
        for (const s of submitBtnSelectors) {
          try {
            const found = await findFrameWithSelector(page, s, 300);
            if (found && found.handle) {
              try { await clickElementByBoundingBox(found.frame, found.handle); clicked = true; break; } catch (e) {}
            }
          } catch (e) {}
        }

        if (!clicked) {
          // fallback: global page button with text Submit
          const anySubmit = await page.$('button:has-text("Submit"), button:has-text("SUBMIT"), button:has-text("submit")');
          if (anySubmit) { try { await clickElementByBoundingBox(page, anySubmit); clicked = true; } catch (e) {} }
        }

        await sleep(400);
        return { ok: true, clickedSubmit: clicked };
      } catch (e) {
        console.warn('Error filling deemed email/phone popup:', e && e.message ? e.message : e);
        return { ok: false, reason: 'exception', error: e && e.message ? e.message : e };
      }
    }

    // --- selectPaymentMethodAndTriggerGPay (unchanged) ---
    async function selectPaymentMethodAndTriggerGPay(page, gpayNumber) {
      try {
        const methodContainerSel = '.sc-oq18pv-12.dvepIO';
        const gpayProviderSel = '.sc-13jes1z-0.kRNNvW';
        const gpayMobileSel = '#mobile';
        const verifyPayBtnSel = '.sc-zgl7vj-7.jseTNq';

        let containerClicked = false;
        for (let i = 0; i < 4; i++) {
          const el = await page.$(methodContainerSel);
          if (el) {
            try { await clickElementByBoundingBox(page, el); containerClicked = true; break; } catch (e) {}
          }
          await sleep(300);
        }
        if (!containerClicked) console.warn('Payment method container not clicked (selector may differ).');

        let providerClicked = false;
        for (let i = 0; i < 5; i++) {
          const el = await page.$(gpayProviderSel);
          if (el) {
            try { await clickElementByBoundingBox(page, el); providerClicked = true; break; } catch (e) {}
          }
          await sleep(300);
        }
        if (!providerClicked) console.warn('GPay provider element not clicked (selector may differ).');

        if (gpayNumber) {
          const start = Date.now();
          let mobileEl = null;
          while ((Date.now() - start) < 6000) {
            mobileEl = await page.$(gpayMobileSel);
            if (mobileEl) break;
            await sleep(300);
          }
          if (mobileEl) {
            try { await mobileEl.fill(String(gpayNumber)); } catch (e) {
              await page.evaluate((sel, val) => {
                const el = document.querySelector(sel);
                if (el) { el.focus(); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
              }, gpayMobileSel, String(gpayNumber));
            }
          } else console.warn('#mobile input (gpay) not found within timeout.');
        } else console.warn('gpayNumber empty; skipping mobile fill.');

        const startBtnWait = Date.now();
        let clickedVerify = false;
        while ((Date.now() - startBtnWait) < 8000) {
          const btn = await page.$(verifyPayBtnSel);
          if (btn) {
            const isDisabled = await btn.evaluate(b => b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true' || (b.className && b.className.includes('disabled')));
            if (!isDisabled) {
              try { await clickElementByBoundingBox(page, btn); clickedVerify = true; break; } catch (e) {}
            }
          }
          await sleep(400);
        }
        if (!clickedVerify) console.warn('Verify & Pay button not clicked (may be disabled or selector changed).');
        return { ok: true, clickedVerify };
      } catch (e) {
        console.warn('Error selecting payment method or triggering GPay:', e && e.message ? e.message : e);
        return { ok: false, error: e && e.message ? e.message : e };
      }
    }

    // ---------- Orchestration (main) ----------
    console.log('Opening theatre page:', THEATRE_URL);
    timers.gotoStart = Date.now();
    await page.goto(THEATRE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    timers.gotoEnd = Date.now();

    console.log('Waiting for document.readyState === "complete"...');
    timers.waitReadyStart = Date.now();
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: READY_TIMEOUT_MS }).catch(() => {});
    timers.waitReadyEnd = Date.now();
    console.log('Document ready (or timed out).');

    console.log('Searching gridcell for movie id:', MOVIE_ID);
    timers.findCellStart = Date.now();
    const gridcell = await findGridcellByMovieId(page, MOVIE_ID);
    timers.findCellEnd = Date.now();
    if (!gridcell) throw new Error('Could not find the gridcell for movie id ' + MOVIE_ID);
    console.log('Found gridcell — attempting fast showtime click.');

    timers.showtimeClickStart = Date.now();
    let clickedOk = false;
    for (let attempt = 1; attempt <= 2 && !clickedOk; ++attempt) {
      try {
        await clickShowtimeInGridcell(page, gridcell, SHOW_INDEX);
        const state = await waitForSeatLayoutOrPopup(page, CLICK_NAV_WAIT_MS);
        if (state.type === 'navigation' || state.type === 'popup') {
          console.log('Showtime click produced state:', state.type, state.url ? state.url : '');
          clickedOk = true; break;
        } else {
          console.log(`Attempt ${attempt}: click didn't show seat UI; retrying immediately.`);
        }
      } catch (e) {
        console.warn(`Attempt ${attempt} click error:`, e.message || e);
      }
    }
    timers.showtimeClickEnd = Date.now();
    if (!clickedOk) throw new Error('Unable to trigger seat layout / popup after showtime clicks');

    console.log('Handling seat quantity and clicking Select Seats (fast).');
    timers.selectQtyStart = Date.now();
    const seatRes = await handleSeatQuantityAndSelectSeats(page, SEAT_QUANTITY);
    timers.selectQtyEnd = Date.now();
    if (!seatRes.ok) console.warn('Could not click Select Seats:', seatRes); else console.log('Clicked Select Seats (method):', seatRes.method);

    console.log('Waiting for seat layout (konvajs or canvas) to be present...');
    timers.waitSeatLayoutStart = Date.now();
    await page.waitForFunction(() => !!document.querySelector('.konvajs-content') || !!document.querySelector('canvas') || window.location.href.includes('/seat-layout/'), { timeout: 10000 }).catch(() => { });
    timers.waitSeatLayoutEnd = Date.now();
    await page.waitForTimeout(300);

    // Run injected scanner (kept same as you had)
    const injectedConfig = {
      targetSeat: TARGET_SEAT,
      quantity: SEAT_QUANTITY,
      nextSeats: NEXT_SEATS,
      seatSizeEstimate: 21,
      coarseYStep: 24,
      coarseYStep_recheck: 3,
      probesPerRow: 9,
      hoverDelay: 6,
      rowTolerance: 12,
      edgeTolerance: 6,
      denseXStep: 2,
      colTolerance: 10,
      dispatchToCanvas: true,
      drawOverlay: true,
      afterClickWait: 500,
      scanTimeout: SCAN_TIMEOUT
    };

    console.log('Injecting in-page seat scanner and executing — TARGET_SEAT:', injectedConfig.targetSeat);
    timers.injectStart = Date.now();

    const result = await page.evaluate(async (CFG) => {
      /* --- injected scanner code (preserved exactly) --- */
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      function dispatchPointer(target, type, clientX, clientY) {
        try { const ev = new PointerEvent(type, { bubbles:true, cancelable:true, composed:true, pointerType:'mouse', isPrimary:true, clientX, clientY, button:0, buttons:1 }); return target.dispatchEvent(ev); } catch(e){return false;}
      }
      function dispatchMouse(target, type, clientX, clientY) {
        try { const ev = new MouseEvent(type, { bubbles:true, cancelable:true, composed:true, clientX, clientY, button:0, buttons:1 }); return target.dispatchEvent(ev); } catch(e){return false;}
      }
      function findCanvasElement() {
        const pref = document.querySelector('.konvajs-content[role="presentation"]');
        if (pref) { const c = pref.querySelector('canvas'); if (c) return c; }
        const canvases = Array.from(document.querySelectorAll('canvas')).filter(c => { const r = c.getBoundingClientRect(); return r.width > 20 && r.height > 20; });
        if (!canvases.length) return null;
        let best = canvases[0], bestA = 0;
        canvases.forEach(cv => { const r = cv.getBoundingClientRect(); const a = Math.max(0, r.width) * Math.max(0, r.height); if (a > bestA) { bestA = a; best = cv; } });
        return best;
      }
      async function probePoint(x,y,canvasEl) {
        try { dispatchPointer(document, 'pointermove', x, y); dispatchMouse(document, 'mousemove', x, y); dispatchPointer(canvasEl, 'pointermove', x, y); dispatchMouse(canvasEl, 'mousemove', x, y); } catch(e){}
        await sleep(CFG.hoverDelay);
        const el = document.elementFromPoint(x,y) || canvasEl;
        let cursor = '';
        try { cursor = (window.getComputedStyle(el).cursor || '').toLowerCase(); } catch(e){ cursor = ''; }
        return { x,y,el,cursor,isPointer: cursor === 'pointer' };
      }
      function toRowLabel(num) { let n=num, label=''; while(n>0){ const r=(n-1)%26; label=String.fromCharCode(65+r)+label; n=Math.floor((n-1)/26);} return label; }
      function parseSeatId(id){ if(!id||typeof id!=='string') return null; const s=id.trim().toUpperCase(); const m=s.match(/^([A-Z]+)\s*0*([0-9]+)$/); if(!m) return null; const letters=m[1], digits=parseInt(m[2],10); let n=0; for(let i=0;i<letters.length;i++) n=n*26+(letters.charCodeAt(i)-64); return {raw:s,rowLabel:letters,rowIndex:n,colIndex:digits}; }
      function payButtonPresent() {
        const containers = document.querySelectorAll('.sc-zgl7vj-0.fvgGCE, .sc-zgl7vj-0.cZKSrH');
        if (!containers.length) return false;
        for (const c of containers) {
          if (c.querySelector('.sc-zgl7vj-8.hpVUcY')) return true;
          if (c.querySelector('button, [role="button"], a')) return true;
          const pointerDiv = Array.from(c.querySelectorAll('div')).find(d => {
            const cs = d.style.cursor || '';
            return (cs === 'pointer' || cs === 'hand');
          });
          if (pointerDiv) return true;
        }
        return false;
      }
      async function detectRowsWithRecheck(canvasEl, rect, timeoutMs) {
        const tStart = Date.now(); const rows = [];
        const minY = rect.top + CFG.edgeTolerance; const maxY = rect.top + rect.height - CFG.edgeTolerance;
        const coarseStep = Math.max(4, CFG.coarseYStep); const recheckRange = Math.max(2, CFG.coarseYStep_recheck);
        const probes = Math.max(3, CFG.probesPerRow);
        let y = minY;
        while (y <= maxY && (Date.now() - tStart) < timeoutMs) {
          let anyHit = false;
          for (let i = 0; i < probes; i++) {
            const fx = (i + 0.5) / probes;
            const x = Math.round(rect.left + CFG.edgeTolerance + Math.max(0, Math.min(rect.width - 2*CFG.edgeTolerance, Math.floor((rect.width - 2*CFG.edgeTolerance) * fx))));
            const res = await probePoint(x, y, canvasEl);
            if (res.isPointer) { anyHit = true; break; }
          }
          if (!anyHit) {
            const startRe = Math.max(minY, y - recheckRange);
            const reStep = Math.max(2, Math.floor(recheckRange / 3));
            let reFound = false;
            for (let ry = startRe; ry < y && !reFound; ry += reStep) {
              for (let i = 0; i < probes; i++) {
                const fx = (i + 0.5) / probes;
                const x = Math.round(rect.left + CFG.edgeTolerance + Math.max(0, Math.min(rect.width - 2*CFG.edgeTolerance, Math.floor((rect.width - 2*CFG.edgeTolerance) * fx))));
                const rp = await probePoint(x, ry, canvasEl);
                if (rp.isPointer) { reFound = true; y = ry; break; }
              }
            }
            if (reFound) anyHit = true;
          }
          if (anyHit) {
            let merged = false;
            for (let i = 0; i < rows.length; i++) { if (Math.abs(rows[i] - y) <= CFG.rowTolerance) { rows[i] = Math.round((rows[i] + y) / 2); merged = true; break; } }
            if (!merged) rows.push(y);
            y += coarseStep;
          } else y += coarseStep;
        }
        rows.sort((a,b) => a - b);
        return rows;
      }
      async function detectColumnsOnRow_improved(canvasEl, rect, rowY, timeoutMs, desiredColEarlyStop = Infinity) {
        const tStart = Date.now(); const columns = [];
        const minX = rect.left + CFG.edgeTolerance; const maxX = rect.left + rect.width - CFG.edgeTolerance;
        const coarseX = Math.max(4, CFG.coarseYStep); const recheckRange = Math.max(2, CFG.coarseYStep_recheck);
        let x = minX;
        while (x <= maxX && (Date.now() - tStart) < timeoutMs) {
          let p = await probePoint(x, rowY, canvasEl);
          if (!p.isPointer) {
            const startRe = Math.max(minX, x - recheckRange);
            const reStep = Math.max(2, Math.floor(recheckRange / 3));
            let reFound = false, foundX = null;
            for (let rx = startRe; rx < x && !reFound; rx += reStep) {
              const rp = await probePoint(rx, rowY, canvasEl);
              if (rp.isPointer) { reFound = true; foundX = rx; break; }
            }
            if (reFound && foundX !== null) { p = await probePoint(foundX, rowY, canvasEl); x = foundX; }
            else { x += coarseX; continue; }
          }
          const denseWindow = Math.max(CFG.seatSizeEstimate * 1.4, coarseX);
          const denseStep = Math.max(2, CFG.denseXStep);
          const startDense = Math.max(minX, Math.round(x - denseWindow / 2));
          const endDense = Math.min(maxX, Math.round(x + denseWindow / 2));
          const samples = [];
          for (let dx = startDense; dx <= endDense; dx += denseStep) {
            const dp = await probePoint(dx, rowY, canvasEl);
            if (dp.isPointer) samples.push(dp.x);
          }
          if (!samples.length) samples.push(p.x);
          const meanX = Math.round(samples.reduce((a,b)=>a+b,0)/samples.length);
          if (!columns.length) columns.push({ xMean: meanX, y: rowY, samplesCount: samples.length });
          else {
            const last = columns[columns.length - 1];
            if (Math.abs(meanX - last.xMean) <= CFG.colTolerance) {
              const tot = last.samplesCount + samples.length;
              last.xMean = Math.round((last.xMean * last.samplesCount + meanX * samples.length) / tot);
              last.samplesCount = tot;
            } else columns.push({ xMean: meanX, y: rowY, samplesCount: samples.length });
          }
          x = meanX + Math.max(Math.round(CFG.seatSizeEstimate * 0.8), coarseX);
          if (columns.length >= desiredColEarlyStop) {
            if (x - columns[columns.length - 1].xMean > Math.max(CFG.seatSizeEstimate * 1.1, 20)) break;
          }
        }
        columns.sort((a,b)=>a.xMean - b.xMean);
        return columns.map(c => ({ x: Math.round(c.xMean), y: Math.round(c.y), samples: c.samplesCount }));
      }
      function syntheticClick(canvasEl, x, y) {
        try {
          const under = document.elementFromPoint(x, y) || canvasEl;
          dispatchPointer(under, 'pointerdown', x, y);
          dispatchMouse(under, 'mousedown', x, y);
          if (CFG.dispatchToCanvas) { dispatchPointer(canvasEl, 'pointerdown', x, y); dispatchMouse(canvasEl, 'mousedown', x, y); }
          const t = performance.now(); while (performance.now() - t < 8) {}
          dispatchPointer(under, 'pointerup', x, y); dispatchMouse(under, 'mouseup', x, y); dispatchMouse(under, 'click', x, y);
          if (CFG.dispatchToCanvas) { dispatchPointer(canvasEl, 'pointerup', x, y); dispatchMouse(canvasEl, 'mouseup', x, y); dispatchMouse(canvasEl, 'click', x, y); }
          return true;
        } catch(e) { return false; }
      }
      const startAll = Date.now();
      const canvasEl = findCanvasElement();
      if (!canvasEl) return { ok:false, why:'no-canvas' };
      const rect = canvasEl.getBoundingClientRect();
      const primary = parseSeatId(CFG.targetSeat);
      if (!primary) return { ok:false, why:'invalid-target' };
      const desiredQty = Math.max(1, Math.floor(CFG.quantity || 1));
      const explicitNext = Array.isArray(CFG.nextSeats) ? CFG.nextSeats.map(s=>s.toUpperCase()) : [];
      const clicked = [], clickedSet = new Set();
      let rowYs = [], columnsCache = {};
      rowYs = await detectRowsWithRecheck(canvasEl, rect, CFG.scanTimeout/2);
      if (!rowYs.length) {
        rowYs = await detectRowsWithRecheck(canvasEl, rect, CFG.scanTimeout);
        if (!rowYs.length) return { ok:false, why:'no-rows-detected' };
      }
      async function ensureColumnsForRow(rowIndex) {
        const label = toRowLabel(rowIndex);
        if (columnsCache[label]) return columnsCache[label];
        if (rowYs.length < rowIndex) {
          const approx = rowYs[rowYs.length-1] + CFG.seatSizeEstimate * (rowIndex - rowYs.length);
          rowYs[rowIndex - 1] = approx;
        }
        const rowY = rowYs[rowIndex - 1];
        const earlyStop = Math.max(primary.colIndex, 6);
        const cols = await detectColumnsOnRow_improved(canvasEl, rect, rowY, 12000, earlyStop);
        columnsCache[label] = cols;
        return cols;
      }
      async function findAndClickSeat(rowIndex, colIndex) {
        const label = `${toRowLabel(rowIndex)}${String(colIndex).padStart(2,'0')}`;
        if (clickedSet.has(label)) return false;
        if (rowYs.length < rowIndex) {
          const more = await detectRowsWithRecheck(canvasEl, rect, 8000);
          if (more.length > rowYs.length) rowYs = more;
          if (rowYs.length < rowIndex) return false;
        }
        const cols = await ensureColumnsForRow(rowIndex);
        if (!cols || !cols.length) return false;
        if (colIndex < 1 || colIndex > cols.length) return false;
        const target = cols[colIndex - 1];
        syntheticClick(canvasEl, target.x, target.y);
        await sleep(CFG.afterClickWait);
        const elAfter = document.elementFromPoint(target.x, target.y) || canvasEl;
        let cursorAfter = '';
        try { cursorAfter = (window.getComputedStyle(elAfter).cursor || '').toLowerCase(); } catch(e) { cursorAfter = ''; }
        const selectedHeuristic = cursorAfter !== 'pointer';
        clicked.push({ label, x: target.x, y: target.y, heuristic: selectedHeuristic });
        clickedSet.add(label);
        return selectedHeuristic || true;
      }
      async function clickSeatByLabel(seatLabel) {
        const parsed = parseSeatId(seatLabel);
        if (!parsed) return false;
        if (rowYs.length < parsed.rowIndex) {
          const more = await detectRowsWithRecheck(canvasEl, rect, 8000);
          if (more.length > rowYs.length) rowYs = more;
        }
        return await findAndClickSeat(parsed.rowIndex, parsed.colIndex);
      }
      await clickSeatByLabel(primary.raw);
      if (payButtonPresent() || clicked.length >= desiredQty) return { ok:true, clicked, reason:'done-after-primary' };
      for (let i=0;i<explicitNext.length && clicked.length<desiredQty;i++) {
        try { await clickSeatByLabel(explicitNext[i]); if (payButtonPresent() || clicked.length >= desiredQty) return { ok:true, clicked, reason:'done-explicit' }; } catch(e){}
      }
      const baseRow = primary.rowIndex, baseCol = primary.colIndex;
      let offset = 1;
      while (clicked.length < desiredQty && (Date.now() - startAll) < CFG.scanTimeout) {
        const tryRow = baseRow + offset;
        if (rowYs.length < tryRow) {
          const more = await detectRowsWithRecheck(canvasEl, rect, 8000);
          if (more.length > rowYs.length) rowYs = more;
          if (rowYs.length < tryRow) { offset++; if (offset > 12) break; continue; }
        }
        const cols = await ensureColumnsForRow(tryRow);
        if (!cols || !cols.length) { offset++; continue; }
        if (baseCol <= cols.length) {
          const label = `${toRowLabel(tryRow)}${String(baseCol).padStart(2,'0')}`;
          if (!clickedSet.has(label)) {
            await findAndClickSeat(tryRow, baseCol);
            if (payButtonPresent() || clicked.length >= desiredQty) return { ok:true, clicked, reason:'done-autofill-down' };
          }
        } else {
          for (let d=0; d<=4 && clicked.length<desiredQty; d++) {
            const left = baseCol - d, right = baseCol + d;
            if (left >= 1 && left <= cols.length && !clickedSet.has(`${toRowLabel(tryRow)}${String(left).padStart(2,'0')}`)) {
              await findAndClickSeat(tryRow, left);
            }
            if (clicked.length >= desiredQty) break;
            if (right >= 1 && right <= cols.length && !clickedSet.has(`${toRowLabel(tryRow)}${String(right).padStart(2,'0')}`)) {
              await findAndClickSeat(tryRow, right);
            }
            if (payButtonPresent() || clicked.length >= desiredQty) return { ok:true, clicked, reason:'done-autofill-down-neighbors' };
          }
        }
        offset++;
      }
      if (clicked.length < desiredQty) {
        let off = 1;
        while (clicked.length < desiredQty && off <= baseRow && (Date.now() - startAll) < CFG.scanTimeout) {
          const tryRow = baseRow - off;
          const cols = await ensureColumnsForRow(tryRow);
          if (cols && cols.length) {
            if (baseCol <= cols.length) {
              await findAndClickSeat(tryRow, baseCol);
              if (payButtonPresent() || clicked.length >= desiredQty) return { ok:true, clicked, reason:'done-above' };
            } else {
              for (let d=0; d<=4 && clicked.length<desiredQty; d++) {
                const left = baseCol - d, right = baseCol + d;
                if (left >= 1 && left <= cols.length && !clickedSet.has(`${toRowLabel(tryRow)}${String(left).padStart(2,'0')}`)) {
                  await findAndClickSeat(tryRow, left);
                }
                if (clicked.length >= desiredQty) break;
                if (right >= 1 && right <= cols.length && !clickedSet.has(`${toRowLabel(tryRow)}${String(right).padStart(2,'0')}`)) {
                  await findAndClickSeat(tryRow, right);
                }
                if (payButtonPresent() || clicked.length >= desiredQty) return { ok:true, clicked, reason:'done-above-neighbors' };
              }
            }
          }
          off++;
        }
      }
      if (payButtonPresent() || clicked.length >= desiredQty) return { ok:true, clicked, reason:'done-final' };
      return { ok:false, reason:'incomplete', clicked, elapsedMs: Date.now() - startAll };
    }, injectedConfig);

    timers.injectEnd = Date.now();
    console.log('Scanner result:', result);

    // AFTER SCANNER: click Pay & Accept (best-effort)
    try {
      console.log('Attempting Pay + Accept Terms sequence (best-effort) ...');
      const clickedPay = await clickPayAndAcceptTerms(page);
      console.log('clickPayAndAcceptTerms ->', clickedPay);
    } catch (e) {
      console.warn('Unexpected error running Pay + Accept sequence:', e && e.message ? e.message : e);
    }

    // ---- NEW: Immediately check redirection URL and handle F&B skip or direct order-summary fill ----
    try {
      // Use event-driven waits: short waitForNavigation OR presence of deemed-email field
      // This is faster and avoids blind sleeps.
      const navOrFormPromise = Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 4500 }).catch(() => null),
        (async () => {
          // small poll for deemed-email presence across frames
          const found = await findFrameWithSelector(page, '#deemed-email', 4500).catch(() => ({ frame: null, handle: null }));
          return found;
        })()
      ]);

      await navOrFormPromise;

      // Now inspect URL and branch
      const redirectedUrl = page.url();
      console.log('Redirected URL (post-Accept):', redirectedUrl);

      if (redirectedUrl && redirectedUrl.includes('food-and-beverages')) {
        console.log('Detected food-and-beverages page. Attempting to click Skip...');
        const skipRes = await clickSkipIfPresent(page);
        console.log('clickSkipIfPresent ->', skipRes);

        // Wait for order-summary URL after skip click (short, event-driven)
        try {
          await Promise.race([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 7000 }).catch(() => null),
            findFrameWithSelector(page, '#deemed-email', 7000).catch(() => ({ frame: null, handle: null }))
          ]);
        } catch (err) { /* ignore */ }

        const afterSkipUrl = page.url();
        console.log('URL after Skip attempt:', afterSkipUrl);

        // Now fill deemed-email & phone on order-summary if present
        if (EMAIL || PHONE) {
          const filled = await fillDeemedEmailAndPhone(page, EMAIL, PHONE);
          console.log('fillDeemedEmailAndPhone (after Skip) ->', filled);
        } else {
          console.log('No EMAIL/PHONE provided; skipping deemed-email filling (after Skip).');
        }

      } else if (redirectedUrl && redirectedUrl.includes('order-summary')) {
        console.log('Detected order-summary page directly. Filling deemed-email & phone (if present).');
        if (EMAIL || PHONE) {
          const filled = await fillDeemedEmailAndPhone(page, EMAIL, PHONE);
          console.log('fillDeemedEmailAndPhone (direct order-summary) ->', filled);
        } else {
          console.log('No EMAIL/PHONE provided; skipping deemed-email filling (direct order-summary).');
        }
      } else {
        // fallback: if deemed-email appears anywhere, fill it
        const fallbackFound = await findFrameWithSelector(page, '#deemed-email', 1000).catch(() => ({ frame: null, handle: null }));
        if (fallbackFound && fallbackFound.handle) {
          if (EMAIL || PHONE) {
            const filled = await fillDeemedEmailAndPhone(page, EMAIL, PHONE);
            console.log('fillDeemedEmailAndPhone (fallback) ->', filled);
          }
        } else {
          console.log('No food-or-order-summary page detected immediately; continuing to payment selection if possible.');
        }
      }
    } catch (e) {
      console.warn('Error while handling post-Accept redirect (F&B / order-summary):', e && e.message ? e.message : e);
    }

    // Finally, attempt payment selection/GPay (unchanged)
    try {
      if (GPAY_NUMBER) {
        console.log('Attempting to select payment method and trigger GPay flow (mobile:', GPAY_NUMBER, ') ...');
        const payRes = await selectPaymentMethodAndTriggerGPay(page, GPAY_NUMBER);
        console.log('selectPaymentMethodAndTriggerGPay result:', payRes);
      } else {
        console.log('No GPAY_NUMBER provided; skipping GPay trigger step.');
      }
    } catch (e) {
      console.warn('Error during payment method/GPay step:', e && e.message ? e.message : e);
    }

    // ---- finalize timers and summary ----
    timers.end = Date.now();
    console.log('--- TIMING SUMMARY ---');
    console.log('Total elapsed:', formatMs(timers.end - timers.start));
    console.log('page.goto():', formatMs((timers.gotoEnd || 0) - (timers.gotoStart || 0)));
    console.log('waitForReady():', formatMs((timers.waitReadyEnd || 0) - (timers.waitReadyStart || 0)));
    console.log('findGridcellByMovieId():', formatMs((timers.findCellEnd || 0) - (timers.findCellStart || 0)));
    console.log('showtimeClick attempts:', formatMs((timers.showtimeClickEnd || 0) - (timers.showtimeClickStart || 0)));
    console.log('handleSeatQuantityAndSelectSeats():', formatMs((timers.selectQtyEnd || 0) - (timers.selectQtyStart || 0)));
    console.log('waitForSeatLayout():', formatMs((timers.waitSeatLayoutEnd || 0) - (timers.waitSeatLayoutStart || 0)));
    console.log('injected scanner run:', formatMs((timers.injectEnd || 0) - (timers.injectStart || 0)));

    console.log('\nAutomation progressed up to payment trigger. Browser is left open for you to manually complete the payment on your device.');
    console.log('Temporary profile dir (inspect/delete later):', tmpProfileDir);

    return {
      ok: true,
      tmpProfileDir,
      scannerResult: result,
      timings: timers,
      message: 'Automation completed up to payment trigger. Browser left open for manual completion.'
    };

  } catch (err) {
    console.error('Fatal error:', err && err.message ? err.message : err);
    try { if (context) { await context.close(); } } catch (e) {}
    return { ok: false, error: err && err.message ? err.message : err };
  }
}

/**
 * _runBookingAutomation(task)
 * - wrapper used by your WatcherManager
 */
async function _runBookingAutomation(task = {}) {
  if (!task) throw new Error('_runBookingAutomation called without task');
  const bs = task.bookingSettings || {};

  const options = {
    cinemaUrl: bs.THEATRE_URL || task.cinemaUrl || '',
    movieId: bs.MOVIE_ID || task.identifier || '',
    showIndex: bs.SHOW_INDEX || bs.SHOW_INDEX === 0 ? Number(bs.SHOW_INDEX) : (bs.SHOW_INDEX ? Number(bs.SHOW_INDEX) : (task.showIndex || 1)),
    seatQuantity: bs.SEAT_QUANTITY || bs.SEAT_QUANTITY === 0 ? Number(bs.SEAT_QUANTITY) : (task.seatQuantity || 1),
    targetSeat: bs.TARGET_SEAT || bs.TARGET_SEAT === '' ? bs.TARGET_SEAT : (task.targetSeat || ''),
    nextSeats: Array.isArray(bs.NEXT_SEATS) ? bs.NEXT_SEATS : (bs.NEXT_SEATS ? bs.NEXT_SEATS : (task.nextSeats || [])),
    email: bs.EMAIL || task.email || '',
    phone: bs.MOBILE_NUMBER || bs.PHONE || task.phone || '',
    gpayNumber: bs.GPAY_NUMBER || bs.GPAY_NUMBER === '' ? bs.GPAY_NUMBER : (bs.MOBILE_NUMBER || bs.phone || task.phone || ''),
    chromeBinary: process.env.CHROME_PATH || '',
    headless: (process.env.AUTOMATION_HEADLESS === 'true') || false,
    timeouts: bs.timeouts || task.timeouts || {}
  };

  if (!options.cinemaUrl || !options.movieId) {
    throw new Error(`Insufficient booking data: cinemaUrl="${options.cinemaUrl}" movieId="${options.movieId}"`);
  }

  try {
    console.log(`[autoBook] starting automation for task ${task.id} movie=${options.movieId} url=${options.cinemaUrl}`);
    const res = await autoBookBMS(options);
    console.log(`[autoBook] finished for task ${task.id}`, res && res.ok ? 'OK' : 'FAILED', res && res.error ? res.error : '');
    return { ok: true, result: res };
  } catch (err) {
    console.error(`[autoBook] error for task ${task.id}:`, err && err.message ? err.message : err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { _runBookingAutomation };
