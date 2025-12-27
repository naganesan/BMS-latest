// server/index.js
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const WatcherManager = require('./watcherManager');

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;


const { chromium } = require('playwright');

// =======================
// === Middleware ========
// =======================
app.use(cors());
app.use(bodyParser.json());

// =======================
// === Public folder =====
// =======================
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// =======================
// === Data files =======
// =======================
const dataDir = path.join(__dirname, 'public', 'data');
const locationsFile = path.join(dataDir, 'locations.json');
const cinemasFile = path.join(dataDir, 'cinemas.json');
const tasksFile = path.join(dataDir, 'tasks.json');

// =======================
// === Helper Functions ==
// =======================
function ensureJsonFile(file, defaultValue) {
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2));
      return defaultValue;
    }
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw || JSON.stringify(defaultValue));
  } catch (e) {
    console.warn(`Failed to load ${file}:`, e.message);
    return defaultValue;
  }
}

// =======================
// === Load Data ========
// =======================
const locations = ensureJsonFile(locationsFile, []);
const cinemas = ensureJsonFile(cinemasFile, {});
ensureJsonFile(tasksFile, []); // ensure tasks file exists

// =======================
// === Watcher Manager ===
// =======================
let manager;
(async () => {
  try {
    manager = new WatcherManager({
      maxPages: parseInt(process.env.MAX_CONCURRENT_PAGES || '6', 10),
      pollIntervalSeconds: parseInt(process.env.POLL_INTERVAL_SECONDS || '3', 10),
      tasksFile,
      logger: console
    });
    await manager.init && manager.init(); // in case you later add async init
    console.log('WatcherManager initialized.');
  } catch (e) {
    console.error('WatcherManager init failed:', e.message);
  }
// 
  // Debug

  app.get('/debug/watchers', (req,res) => res.json(manager.debugState()));

  
  // =======================
  // === SSE Endpoint ======
  // =======================
  app.get('/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.flushHeaders();

    const send = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {}
    };

    send({ type: 'connected', time: new Date().toISOString() });
    const unsubscribe = manager.addSseClient(send);

    req.on('close', () => unsubscribe());
  });

  // =======================
  // === API Endpoints =====
  // =======================

  // Serve static JSON data directly from public/data
  app.get('/api/locations', (req, res) => {
    try {
      const locationsPath = path.join(publicDir, 'data', 'locations.json');
      const data = fs.readFileSync(locationsPath, 'utf8');
      res.json({ locations: JSON.parse(data) });
    } catch (err) {
      console.error('Error reading locations.json:', err);
      res.status(500).json({ error: 'Failed to load locations' });
    }
  });

  // --- Cinemas ---
  app.get('/api/cinemas', (req, res) => {
    const loc = req.query.location;
    if (!loc) return res.status(400).json({ error: 'location query required' });

    try {
      const cinemasPath = path.join(publicDir, 'data', 'cinemas.json');
      const data = JSON.parse(fs.readFileSync(cinemasPath, 'utf8'));
      res.json({ cinemas: data[loc] || [] });
    } catch (err) {
      console.error('Error reading cinemas.json:', err);
      res.status(500).json({ error: 'Failed to load cinemas' });
    }
  });


app.get('/api/upcoming', async (req, res) => {
  const loc = req.query.location;
  if (!loc) return res.status(400).json({ error: 'location query required' });

  // URLs to check (released + upcoming)
  const urls = [
    `https://in.bookmyshow.com/explore/upcoming-movies-${encodeURIComponent(loc)}?referrerBase=movies`,
    `https://in.bookmyshow.com/explore/movies-${encodeURIComponent(loc)}?languages=tamil`,
    `https://in.bookmyshow.com/explore/movies-${encodeURIComponent(loc)}?cat=MT`
  ];

  const pwArgs = [
    '--start-maximized',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-plugins',
    '--remote-allow-origins=*'
  ];

  let browser = null;

  // gentle auto-scroll to trigger lazy loading
  async function autoScroll(page, maxIterations = 30, step = 600, pauseMs = 350) {
    try {
      await page.evaluate(async (step, pauseMs, maxIterations) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        let iter = 0;
        let lastHeight = document.body.scrollHeight;
        while (iter < maxIterations) {
          window.scrollBy(0, step);
          await sleep(pauseMs);
          const newHeight = document.body.scrollHeight;
          if (newHeight === lastHeight) break;
          lastHeight = newHeight;
          iter++;
        }
        await sleep(250);
      }, step, pauseMs, maxIterations);
    } catch (e) {
      // ignore evaluate errors
    }
  }

  // extraction inside page: follow the exact nested classes you gave
  async function extractFromPage(page) {
    return await page.evaluate(() => {
      const abs = (href) => {
        try { return new URL(href, location.href).href; } catch (e) { return href || ''; }
      };

      const results = [];

      // Top-level movie container selector you specified
      const topBlockSelector = '.sc-1ljcxl3-0.ldQqlW';
      // nested selectors as described
      const blockAnchorSelector = 'a[href]';
      const nestedBlockSelector = 'div.sc-133848s-3.bbHlLd';
      const nestedInnerSelector = 'div.sc-133848s-2.sc-133848s-12.ccqrhI.jgYpvq';
      const titleSelector = 'div.sc-7o7nez-0.elfplV';

      try {
        const topBlocks = Array.from(document.querySelectorAll(topBlockSelector));
        for (const block of topBlocks) {
          try {
            // find all anchors inside this top-level block (usually one per movie card)
            const anchors = Array.from(block.querySelectorAll(blockAnchorSelector));
            for (const a of anchors) {
              try {
                const href = a.getAttribute('href') || a.href || '';
                const idMatch = href.match(/(ET\d+)/);
                const identifier = idMatch ? idMatch[1] : null;
                // find nested title element inside the anchor following the path you gave
                let name = '';
                try {
                  const nestedBlock = a.querySelector(nestedBlockSelector) || a.querySelector('div.sc-133848s-3');
                  if (nestedBlock) {
                    const nestedInner = nestedBlock.querySelector(nestedInnerSelector) || nestedBlock.querySelector('div.sc-133848s-2');
                    if (nestedInner) {
                      const titleEl = nestedInner.querySelector(titleSelector) || nestedInner.querySelector('div.elfplV') || nestedInner.querySelector('div');
                      if (titleEl && titleEl.textContent) name = titleEl.textContent.trim();
                    } else {
                      // fallback: maybe title is directly under nestedBlock
                      const titleEl2 = nestedBlock.querySelector(titleSelector) || nestedBlock.querySelector('div.elfplV');
                      if (titleEl2 && titleEl2.textContent) name = titleEl2.textContent.trim();
                    }
                  }
                } catch (e) {
                  // ignore nested parse errors
                }

                // final fallback: anchor text
                if (!name) name = (a.textContent || '').trim();

                if (identifier) {
                  results.push({
                    identifier,
                    href: abs(href),
                    name: name || '',
                    source: 'block'
                  });
                }
              } catch (e) {
                // ignore per-anchor errors
              }
            } // anchors loop
          } catch (e) {
            // ignore per-top-block error
          }
        }
      } catch (e) {
        // ignore top-block querying errors
      }

      // If no results found via structured blocks, do a page-wide fallback scan to avoid misses
      if (results.length === 0) {
        try {
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          for (const a of anchors) {
            try {
              const href = a.getAttribute('href') || a.href || '';
              const idMatch = href.match(/(ET\d+)/) || (a.textContent && a.textContent.match(/(ET\d+)/));
              const identifier = idMatch ? idMatch[1] : null;
              if (!identifier) continue;

              // attempt to find nearby title element as best-effort
              let name = (a.textContent || '').trim();
              try {
                // look for nearest title element by walking up then searching inside that ancestor
                let cur = a;
                for (let i = 0; i < 5 && cur; i++) {
                  if (cur.querySelector) {
                    const titleEl = cur.querySelector(titleSelector) || cur.querySelector('div.elfplV');
                    if (titleEl && titleEl.textContent) { name = titleEl.textContent.trim(); break; }
                  }
                  cur = cur.parentElement;
                }
              } catch (e) {}
              results.push({
                identifier,
                href: abs(href),
                name,
                source: 'fallback'
              });
            } catch (e) {}
          }
        } catch (e) {}
      }

      // dedupe by identifier, keep first
      const seen = new Set();
      const unique = [];
      for (const r of results) {
        if (!r.identifier) continue;
        if (!seen.has(r.identifier)) {
          seen.add(r.identifier);
          unique.push(r);
        }
      }
      return unique;
    });
  }

  try {
    browser = await chromium.launch({
      headless: true, // set false for debugging
      args: pwArgs
    });

    const collected = [];

    for (const url of urls) {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
        viewport: null,
        locale: 'en-US',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
      });

      const page = await context.newPage();

      try {
        // Navigate and wait for initial DOM. We attach a short extra wait so client-side rendering starts.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(700);

        // Gentle scroll to load lazy items
        await autoScroll(page, 40, 800, 300);

        // Wait best-effort for the top-level blocks or any ET anchors
        try {
          await page.waitForFunction(() =>
            !!document.querySelector('.sc-1ljcxl3-0.ldQqlW') ||
            !!document.querySelector('.sc-133848s-3.bbHlLd') ||
            !!document.querySelector('a[href*="ET"]'),
            { timeout: 20000 }
          );
        } catch (e) {
          // continue — extraction will fallback
        }

        const pageResults = await extractFromPage(page);
        pageResults.forEach(r => r.sourceUrl = url);
        collected.push(...pageResults);
      } catch (pageErr) {
        console.warn('Error scraping', url, pageErr && pageErr.message ? pageErr.message : pageErr);
      } finally {
        try { await context.close(); } catch (e) {}
      }
    }

    // Merge + dedupe globally by identifier, keep first seen
    const seenIds = new Set();
    const merged = [];
    for (const item of collected) {
      if (!item || !item.identifier) continue;
      if (seenIds.has(item.identifier)) continue;
      seenIds.add(item.identifier);
      merged.push({
        identifier: item.identifier,
        name: item.name || '',
        href: item.href,
        sourceUrl: item.sourceUrl,
        sourceHint: item.source || ''
      });
    }

    try { await browser.close(); } catch (e) {}
    browser = null;

    return res.json({
      ok: true,
      location: loc,
      queriedUrls: urls,
      count: merged.length,
      results: merged
    });
  } catch (err) {
    try { if (browser) await browser.close(); } catch (e) {}
    console.error('Playwright scraping failed:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: (err && err.message) ? err.message : String(err) });
  }
});













  // --- Task Management ---
  app.post('/api/tasks', async (req, res) => {
    const { location, cinemaName, cinemaUrl, identifier, bookingSettings } = req.body;
    if (!location || !cinemaUrl || !identifier)
      return res.status(400).json({ error: 'location, cinemaUrl, identifier required' });

    try {
      const id = await manager.createTask({ location, cinemaName, cinemaUrl, identifier, bookingSettings });
      res.json({ ok: true, id });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/tasks', (req, res) => {
    const all = req.query.all === 'true';
    res.json({ tasks: manager.getTasks({ all }) });
  });

  app.post('/api/tasks/:id/stop', async (req, res) => {
    try {
      const ok = await manager.stopTask(req.params.id);
      res.json({ ok });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  // New: reload/restart watcher for a task (re-inject observer)
  app.post('/api/tasks/:id/reload', async (req, res) => {
    try {
      const ok = await manager.reloadTask(req.params.id);
      if (!ok) return res.status(404).json({ ok: false, error: 'task not found or failed' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  app.delete('/api/tasks/:id', async (req, res) => {
    try {
      const ok = await manager.deleteTask(req.params.id);
      res.json({ ok });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  // =======================
  // === Fallback ========
  // =======================
  app.get('*', (req, res) => {
    const file = path.join(publicDir, 'index.html');
    if (fs.existsSync(file)) res.sendFile(file);
    else res.status(404).send('index.html not found');
  });

  // =======================
  // === Graceful Shutdown =
  // =======================
  process.on('SIGINT', async () => {
    console.log('Gracefully shutting down...');
    if (manager) await manager.shutdown();
    process.exit(0);
  });

  // =======================
  // === Start Server ======
  // =======================
  app.listen(PORT, () => {
    console.log(`✅ BMS Watcher running at http://localhost:${PORT}`);
  });
})();
