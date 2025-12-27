// server/watcher.js
// Playwright-aware Watcher that opens a fresh context/page per task,
// waits for full page load, then injects the mutation-observer + polling scanner
// (your robust snippet), and exposes a unique binding per watcher.

const { v4: uuidv4 } = require('uuid');

class Watcher {
  constructor({ id, cinemaUrl, identifier, pollIntervalSeconds = 5, rotateIntervalMs = 3*60*1000, pageFactory, logger = console } = {}) {
    this.id = id || `watcher-${uuidv4()}`;
    this.cinemaUrl = cinemaUrl;
    this.identifier = identifier;
    this.pollIntervalSeconds = Number(pollIntervalSeconds) || 5;
    this.rotateIntervalMs = Number(rotateIntervalMs) || (5 * 60 * 1000);
    this.pageFactory = pageFactory;
    this.logger = logger;

    this.page = null;         // Playwright Page
    this.context = null;      // Playwright BrowserContext
    this.running = false;
    this.found = false;
    this.foundHref = null;

    this._reloadTimer = null;
    this._rotateTimer = null;
    this._observerInjected = false;

    // unique binding name per watcher to avoid collisions
    this._bindingName = `__bms_onFound_${this.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  }

  async start(onFoundCallback) {
    if (this.running) return;
    this.running = true;
    this.onFoundCallback = onFoundCallback;
    this.logger.log(`[Watcher ${this.id}] start → ${this.cinemaUrl} (looking for ${this.identifier})`);

    try {
      await this._openPageAndAttach(); // open page, wait for load, expose binding, inject observer
      this._scheduleReload();
      this._scheduleRotate();
    } catch (err) {
      this.logger.error(`[Watcher ${this.id}] start error:`, err && err.message ? err.message : err);
      this.running = false;
      throw err;
    }
  }

  // Open fresh page/context via pageFactory and attach observer (waits for load)
  async _openPageAndAttach() {
    // close previous if present
    if (this.page || this.context) {
      await this._closePageContext().catch(() => {});
      this.page = null; this.context = null;
    }

    // pageFactory returns { page, context } or a page
    const res = await this.pageFactory({ taskId: this.id }).catch(err => { throw err; });
    if (!res) throw new Error('pageFactory returned falsy');
    let page, context;
    if (res.page && res.context) { page = res.page; context = res.context; }
    else if (res.page) { page = res.page; context = res.context || (page.context ? page.context() : null); }
    else page = res;

    if (!page) throw new Error('No page from pageFactory');

    this.page = page;
    this.context = context || (page.context ? page.context() : null);

    // Expose unique binding for this watcher. If exposeFunction fails, log and continue.
    try {
      await this.page.exposeFunction(this._bindingName, (href) => {
        try {
          if (!this.found) {
            this.found = true;
            this.foundHref = href;
            this.logger.log(`[Watcher ${this.id}] <<< FOUND via binding ${this._bindingName} >>> ${href}`);
            try { if (this.onFoundCallback) this.onFoundCallback({ id: this.id, href, identifier: this.identifier }); } catch (e) {}
          }
        } catch (e) {}
      });
      this.logger.log(`[Watcher ${this.id}] exposed binding: ${this._bindingName}`);
    } catch (e) {
      this.logger.warn(`[Watcher ${this.id}] exposeFunction failed for ${this._bindingName}:`, e && e.message ? e.message : e);
    }

    // Navigate to cinema URL and wait for full load
    try {
      await this.page.goto(this.cinemaUrl, { waitUntil: 'load', timeout: 45000 });
      // extra guard: wait for networkidle if necessary (best-effort)
      try { await this.page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (_) {}
      this.logger.log(`[Watcher ${this.id}] navigation to cinemaUrl completed (load state)`);
    } catch (gotoErr) {
      this.logger.warn(`[Watcher ${this.id}] initial goto failed: ${gotoErr && gotoErr.message ? gotoErr.message : gotoErr}. Attempting reload, then continue.`);
      try { await this.page.reload({ waitUntil: 'load', timeout: 30000 }); } catch (reloadErr) { this.logger.warn(`[Watcher ${this.id}] reload failed: ${reloadErr && reloadErr.message ? reloadErr.message : reloadErr}`); }
    }

    // Once page is loaded (or after fallback reload), inject observer script
    await this._injectObserverScript();
  }

  // Inject mutation observer script adapted from your snippet and call binding on found
  async _injectObserverScript() {
    if (!this.page) throw new Error('No page to inject observer into');
    const CODE = String(this.identifier || '');
    const BINDING = this._bindingName;
    const LINK_SELECTOR = 'a.sc-1412vr2-2.gwQhog';
    const CONTAINER_SELECTOR = '.sc-1buex3e-2.kHDWIU .sc-1uqfc1q-2.fJmAJQ .sc-1rrxquc-1.goFTYV .ReactVirtualized__Grid.ReactVirtualized__List .ReactVirtualized__Grid__innerScrollContainer';

    const script = `(function() {
      try {
        const CODE = ${JSON.stringify(CODE)};
        const LINK_SELECTOR = ${JSON.stringify(LINK_SELECTOR)};
        const CONTAINER_SELECTOR = ${JSON.stringify(CONTAINER_SELECTOR)};
        const bindingName = ${JSON.stringify(BINDING)};

        function findLink() {
          try {
            // 1) Preferred selector
            const anchors = document.querySelectorAll(LINK_SELECTOR);
            for (const a of anchors) {
              try {
                const href = (a.getAttribute('href')||'') + '';
                const text = (a.textContent||'') + '';
                if (href.includes(CODE) || text.includes(CODE)) return a;
              } catch(e){}
            }

            // 2) Search inside container
            const container = document.querySelector(CONTAINER_SELECTOR) || document.body;
            if (container) {
              const any = Array.from(container.querySelectorAll('a')).find(a => {
                try { const h = (a.getAttribute('href')||'')+''; const t = (a.textContent||'')+''; return h.includes(CODE) || t.includes(CODE); } catch(e){ return false; }
              });
              if (any) return any;
            }

            // 3) Global fallback
            const globalAny = Array.from(document.querySelectorAll('a')).find(a => {
              try { const h=(a.getAttribute('href')||'')+''; const t=(a.textContent||'')+''; return h.includes(CODE) || t.includes(CODE); } catch(e) { return false; }
            });
            return globalAny || null;
          } catch (e) { return null; }
        }

        function done(link, source) {
          try {
            const href = link && (link.href || (link.getAttribute && link.getAttribute('href')) ) || null;
            console.log('✅ Link found via ' + source + ':', href);
            if (bindingName && window[bindingName] && typeof window[bindingName] === 'function') {
              try { window[bindingName](href); } catch(e) { console.warn('binding call failed', e); }
            } else {
              // fallback: dispatch event
              try { window.dispatchEvent(new CustomEvent('__bms_found', { detail: { href } })); } catch(e){}
            }
          } catch (e) { console.warn('done error', e); }
        }

        // immediate check
        const initial = findLink();
        if (initial) { done(initial, 'initial scan'); return; }

        // attach observers
        const observers = [];
        function createObserver(target, label) {
          try {
            const obs = new MutationObserver(() => {
              try {
                const link = findLink();
                if (link) { observers.forEach(o => { try{ o.disconnect(); }catch(_){} }); clearInterval(pollId); done(link, label); }
              } catch(e){}
            });
            obs.observe(target, { childList: true, subtree: true });
            observers.push(obs);
          } catch(e){}
        }

        const targetNode = document.querySelector(CONTAINER_SELECTOR);
        if (targetNode) {
          createObserver(targetNode, 'container observer');
        } else {
          console.warn('Target container not found; will observe document.body as fallback.');
        }
        createObserver(document.body, 'document observer');

        // polling safety net
        const pollId = setInterval(() => {
          try {
            const link = findLink();
            if (link) { observers.forEach(o => { try{ o.disconnect(); }catch(_){} }); clearInterval(pollId); done(link, 'polling'); }
          } catch(e){}
        }, 500);

        console.log('🔎 Watching for link containing', CODE, '...');
      } catch (err) { console.warn('observer injection failed', err); }
    })();`;

    try {
      await this.page.evaluate(script => { const fn = new Function(script); return fn(); }, script);
      this._observerInjected = true;
      this.logger.log(`[Watcher ${this.id}] MutationObserver injected (binding: ${BINDING})`);
    } catch (e) {
      this._observerInjected = false;
      this.logger.error(`[Watcher ${this.id}] _injectObserverScript error:`, e && e.message ? e.message : e);
      throw e;
    }
  }

  // periodic reload: navigate to cinemaUrl again, wait for load, re-expose binding and re-inject observer
  _scheduleReload() {
    if (this.pollIntervalSeconds <= 0) return;
    if (this._reloadTimer) clearTimeout(this._reloadTimer);

    this._reloadTimer = setTimeout(async () => {
      if (!this.running || this.found) return;
      try {
        this.logger.log(`[Watcher ${this.id}] Reloading page to catch dynamic updates (will navigate to cinemaUrl) ...`);
        if (!this.page) {
          // open fresh if page closed unexpectedly
          await this._openPageAndAttach().catch((e) => { this.logger.warn(`[Watcher ${this.id}] reopen failed: ${e && e.message ? e.message : e}`); });
        } else {
          try {
            await this.page.goto(this.cinemaUrl, { waitUntil: 'load', timeout: 45000 });
            try { await this.page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (_) {}
            this.logger.log(`[Watcher ${this.id}] reload navigation complete (load)`);
          } catch (navErr) {
            this.logger.warn(`[Watcher ${this.id}] reload navigation failed: ${navErr && navErr.message ? navErr.message : navErr}`);
            try { await this.page.reload({ waitUntil: 'load', timeout: 30000 }); } catch (_) {}
          }

          // re-expose binding safely (fresh context avoids collisions, but re-expose in case)
          try {
            await this.page.exposeFunction(this._bindingName, (href) => {
              if (!this.found) {
                this.found = true;
                this.foundHref = href;
                this.logger.log(`[Watcher ${this.id}] <<< FOUND (via re-exposed) >>> ${href}`);
                if (this.onFoundCallback) this.onFoundCallback({ id: this.id, href, identifier: this.identifier });
              }
            });
          } catch (e) { /* ignore expose errors */ }

          // re-inject observer
          await this._injectObserverScript().catch(err => {
            this.logger.warn(`[Watcher ${this.id}] re-inject observer failed: ${err && err.message ? err.message : err}`);
          });
        }
      } catch (e) {
        this.logger.error(`[Watcher ${this.id}] error during reload/attach:`, e && e.message ? e.message : e);
      } finally {
        this._scheduleReload();
      }
    }, this.pollIntervalSeconds * 1000);
  }

  // rotate: create fresh page/context, navigate+inject, then close old context (keeps session fresh)
  _scheduleRotate() {
    if (!this.rotateIntervalMs || this.rotateIntervalMs <= 0) return;
    if (this._rotateTimer) clearTimeout(this._rotateTimer);

    this._rotateTimer = setTimeout(async () => {
      if (!this.running || this.found) return;
      try {
        this.logger.log(`[Watcher ${this.id}] rotating page/context to refresh session`);
        const oldPage = this.page, oldContext = this.context;
        await this._openPageAndAttach().catch(err => {
          this.logger.warn(`[Watcher ${this.id}] rotate open+attach failed: ${err && err.message ? err.message : err}`);
        });

        // close old ones only after new attached (best-effort)
        try {
          if (oldPage && !oldPage.isClosed && typeof oldPage.close === 'function') await oldPage.close().catch(()=>{});
          if (oldContext && typeof oldContext.close === 'function') await oldContext.close().catch(()=>{});
        } catch (_) {}
      } catch (e) {
        this.logger.warn(`[Watcher ${this.id}] rotate failed:`, e && e.message ? e.message : e);
      } finally {
        this._scheduleRotate();
      }
    }, this.rotateIntervalMs);
  }

  async _closePageContext() {
    if (this._reloadTimer) { clearTimeout(this._reloadTimer); this._reloadTimer = null; }
    if (this._rotateTimer) { clearTimeout(this._rotateTimer); this._rotateTimer = null; }

    try {
      if (this.page && !this.page.isClosed && typeof this.page.close === 'function') await this.page.close().catch(()=>{});
    } catch (_) {}
    try {
      if (this.context && typeof this.context.close === 'function') await this.context.close().catch(()=>{});
      else if (this.page && typeof this.page.context === 'function') {
        const ctx = this.page.context();
        if (ctx && ctx.close) await ctx.close().catch(()=>{});
      }
    } catch (_) {}
    this.page = null;
    this.context = null;
    this._observerInjected = false;
  }

  async stop() {
    this.running = false;
    this.found = false;
    this.foundHref = null;
    if (this._reloadTimer) { clearTimeout(this._reloadTimer); this._reloadTimer = null; }
    if (this._rotateTimer) { clearTimeout(this._rotateTimer); this._rotateTimer = null; }
    try { await this._closePageContext(); } catch (e) {}
    this.logger.log(`[Watcher ${this.id}] stopped`);
  }
}

module.exports = Watcher;
