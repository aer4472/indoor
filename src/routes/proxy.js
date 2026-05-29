const express = require('express');
const router  = express.Router();
const https   = require('https');
const http    = require('http');
const zlib    = require('zlib');

function fetchUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Muitos redirecionamentos'));
    let parsed;
    try { parsed = new URL(url); } catch(e) { return reject(new Error('URL inválida')); }
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121',
        'Accept':          'text/html,application/xhtml+xml,application/xml,application/rss+xml,*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Cache-Control':   'no-cache',
      },
      timeout: 12000
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        req.destroy();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return resolve(fetchUrl(next, redirects + 1));
      }
      if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode));

      // Descomprimir gzip/deflate/br automaticamente
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if      (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      stream.on('data',  c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      stream.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function blockPrivate(url) {
  try { return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(new URL(url).hostname); }
  catch { return true; }
}

function cleanText(t) {
  return (t||'')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
}

function extractRSS(text) {
  const items = []; const rx = /<item[\s\S]*?<\/item>/gi; const tx = /<title[^>]*>([\s\S]*?)<\/title>/i; let m;
  while ((m = rx.exec(text)) !== null) { const t=m[0].match(tx); if(t?.[1]){const c=cleanText(t[1]); if(c.length>5) items.push(c);} }
  return items;
}

function extractAtom(text) {
  const items = []; const rx = /<entry[\s\S]*?<\/entry>/gi; const tx = /<title[^>]*>([\s\S]*?)<\/title>/i; let m;
  while ((m = rx.exec(text)) !== null) { const t=m[0].match(tx); if(t?.[1]){const c=cleanText(t[1]); if(c.length>5) items.push(c);} }
  return items;
}

function extractJSONLD(html) {
  const items=[]; const rx=/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi; let m;
  while((m=rx.exec(html))!==null){
    try{
      const data=JSON.parse(m[1]); const list=Array.isArray(data)?data:[data];
      for(const obj of list){
        if(obj['@type']==='ItemList'&&obj.itemListElement) for(const el of obj.itemListElement){const n=el.name||el.item?.name||el.item?.headline; if(n&&n.length>5) items.push(cleanText(n));}
        if(['NewsArticle','Article','BlogPosting'].includes(obj['@type'])){const h=obj.headline||obj.name; if(h&&h.length>5) items.push(cleanText(h));}
      }
    }catch{}
  }
  return items;
}

function extractHTMLHeadlines(html) {
  const items=[]; const seen=new Set();
  const SKIP=/^(home|sobre|contato|menu|busca|login|cadastr|assinar|newsletter|publicidade|editoriais?|veja mais|leia mais|clique aqui)$/i;
  const pats=[
    /<article[^>]*>[\s\S]*?<h[123][^>]*>([\s\S]*?)<\/h[123]>/gi,
    /<[^>]+class="[^"]*(?:title|titulo|headline|noticia|card-title|post-title|entry-title|news-title)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi,
    /<h2[^>]*>([\s\S]*?)<\/h2>/gi,
    /<h3[^>]*>([\s\S]*?)<\/h3>/gi,
  ];
  for(const rx of pats){
    let m;
    while((m=rx.exec(html))!==null){
      const c=cleanText(m[1]);
      if(c.length<10||c.length>250||seen.has(c)||SKIP.test(c)) continue;
      seen.add(c); items.push(c);
    }
    if(items.length>=20) break;
  }
  return items;
}

function findRSSLinks(html, baseUrl) {
  const links=[]; const rx=/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*href=["']([^"']+)["'][^>]*>/gi; let m;
  while((m=rx.exec(html))!==null){
    try{ links.push(m[1].startsWith('http')?m[1]:new URL(m[1],baseUrl).href); }catch{}
  }
  return links;
}

// ── ROTA PRINCIPAL ─────────────────────────────────────────────────
router.get('/news', async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const { url } = req.query;
  if (!url) return res.status(400).end(JSON.stringify({ error: 'Parâmetro url obrigatório', items: [] }));
  if (blockPrivate(url)) return res.status(403).end(JSON.stringify({ error: 'URL bloqueada', items: [] }));

  try {
    const content = await fetchUrl(url);
    const trimmed = content.trimStart();
    const isXML   = trimmed.startsWith('<?xml') || trimmed.includes('<rss') || trimmed.includes('<feed xmlns');

    if (isXML) {
      let items = extractRSS(content);
      if (!items.length) items = extractAtom(content);
      return res.end(JSON.stringify({ items: items.slice(0,30), source: 'rss' }));
    }

    // 1. RSS no <head>
    const rssLinks = findRSSLinks(content, url);
    for (const link of rssLinks) {
      try {
        const rc = await fetchUrl(link);
        let items = extractRSS(rc); if(!items.length) items = extractAtom(rc);
        if (items.length) return res.end(JSON.stringify({ items: items.slice(0,30), source: 'rss-autodiscovered' }));
      } catch {}
    }

    // 2. JSON-LD
    const jl = extractJSONLD(content);
    if (jl.length >= 3) return res.end(JSON.stringify({ items: jl.slice(0,30), source: 'json-ld' }));

    // 3. HTML scraping
    const hl = extractHTMLHeadlines(content);
    if (hl.length >= 3) return res.end(JSON.stringify({ items: hl.slice(0,30), source: 'html-scrape' }));

    // 4. Feeds comuns na raiz do domínio
    try {
      const base = url.match(/^(https?:\/\/[^/]+)/)?.[1];
      if (base) {
        for (const p of ['/feed','/rss','/feed.xml','/rss.xml','/atom.xml']) {
          try {
            const fc = await fetchUrl(base + p);
            let items = extractRSS(fc); if(!items.length) items = extractAtom(fc);
            if (items.length) return res.end(JSON.stringify({ items: items.slice(0,30), source: 'feed-root' }));
          } catch {}
        }
      }
    } catch {}

    // Diagnóstico
    const bodyLen = content.replace(/<[^>]+>/g,'').trim().length;
    const hint = bodyLen < 500
      ? 'Site usa JavaScript/React para carregar conteúdo. Cole a URL do feed RSS do site (geralmente /feed ou /rss).'
      : 'Estrutura do site não reconhecida. Tente a URL do feed RSS direto.';

    return res.end(JSON.stringify({ items: [], source: 'none', hint }));

  } catch(e) {
    return res.status(502).end(JSON.stringify({
      error: 'Erro: ' + e.message,
      items: [],
      hint: 'Verifique se a URL está correta e o site está online.'
    }));
  }
});

// Compatibilidade
router.get('/rss', (req, res) => {
  res.redirect(307, '/api/proxy/news?url=' + encodeURIComponent(req.query.url || ''));
});

module.exports = router;
