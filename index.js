const express = require('express');
const Parser = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const parser = new Parser({ timeout: 10000, headers: { 'User-Agent': 'Briefcast/1.0' } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── RSS Sources ───────────────────────────────────────────────
const SOURCES = [
  // Global
  { name: 'Reuters',            url: 'https://feeds.reuters.com/reuters/topNews',                    category: 'global' },
  { name: 'AP News',            url: 'https://rsshub.app/apnews/topics/apf-topnews',                 category: 'global' },
  { name: 'Financial Times',    url: 'https://www.ft.com/rss/home',                                  category: 'global' },
  { name: 'The Economist',      url: 'https://www.economist.com/the-world-this-week/rss.xml',        category: 'global' },
  // Africa
  { name: 'Daily Maverick',     url: 'https://www.dailymaverick.co.za/feed/',                        category: 'africa' },
  { name: 'AllAfrica',          url: 'https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf', category: 'africa' },
  { name: 'News24',             url: 'https://feeds.news24.com/articles/news24/TopStories/rss',      category: 'africa' },
  // Korea
  { name: 'Korea JoongAng',     url: 'https://koreajoongangdaily.joins.com/section/rss/all.xml',     category: 'korea' },
  { name: 'Korea Herald',       url: 'http://www.koreaherald.com/rss/include/rss_topnews_all.php',   category: 'korea' },
  { name: 'Yonhap News',        url: 'https://en.yna.co.kr/RSS/news.xml',                            category: 'korea' },
  { name: 'Hankyoreh',          url: 'https://english.hani.co.kr/rss/',                              category: 'korea' },
  // Science & Tech
  { name: 'Marginal Revolution', url: 'https://marginalrevolution.com/feed',                         category: 'science' },
  { name: 'Ars Technica',       url: 'http://feeds.arstechnica.com/arstechnica/index',               category: 'science' },
  { name: 'Nature',             url: 'https://www.nature.com/nature.rss',                            category: 'science' },
  // Business
  { name: 'FT Markets',         url: 'https://www.ft.com/rss/markets',                              category: 'business' },
  { name: 'Reuters Business',   url: 'https://feeds.reuters.com/reuters/businessNews',               category: 'business' },
  // Rugby
  { name: 'Rugby365',           url: 'https://rugby365.com/feed/',                                   category: 'rugby' },
  { name: 'SA Rugby Mag',       url: 'https://www.sarugbymag.co.za/feed/',                           category: 'rugby' },
  { name: 'URC Rugby',          url: 'https://www.urcrugby.com/rss.xml',                             category: 'rugby' },
];

async function fetchFeed(source) {
  try {
    const feed = await parser.parseURL(source.url);
    return (feed.items || []).slice(0, 6).map(item => ({
      source: source.name,
      category: source.category,
      title: (item.title || '').trim(),
      summary: (item.contentSnippet || item.summary || '').slice(0, 400).trim(),
    }));
  } catch (e) {
    console.warn(`⚠️  ${source.name}: ${e.message}`);
    return [];
  }
}

async function fetchAllNews() {
  const results = await Promise.allSettled(SOURCES.map(fetchFeed));
  const allItems = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const byCategory = {};
  for (const item of allItems) {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  }
  return byCategory;
}

// ── Claude Prompt ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the host of Briefcast, a personalised 15-minute morning news podcast. Your voice is professional and neutral — calm, measured, intellectually curious. Think: a Financial Times editor who has read Marginal Revolution for a decade, with the globally-minded empiricism of Tyler Austin Harper and the historical seriousness of Thomas C. Mann.

Write a podcast SCRIPT to be read aloud. No markdown, no bullet points, no headers — clean flowing prose broken into labeled segments.

Listener profile:
- Columbus, Ohio
- Interests: World politics, Tech & Science, Business & Finance, African news (esp. South Africa), Korean news (Korea-first for Asia), SA rugby (Stormers → URC → broader SA rugby)
- Politics: centrist, empirical, non-partisan. No Fox News or MSNBC framing whatsoever.
- Reads: Marginal Revolution, NYT, FT, Monocle. Authors like Thomas C. Mann and Tyler Austin Harper.

OUTPUT FORMAT — exactly 7 segments with these labels:
[SEGMENT: Global Headlines | ~4 min]
[SEGMENT: Africa | ~1.5 min]
[SEGMENT: Korea & Asia | ~1.5 min]
[SEGMENT: Science & Technology | ~2 min]
[SEGMENT: Business & Markets | ~2 min]
[SEGMENT: Rugby | ~1 min]
[SEGMENT: 한국어 요약 | ~2 min]

RULES:
- Use ONLY the real news stories provided. Do not invent or add stories.
- Natural spoken English — contractions fine, no stiff prose.
- Each segment opens with a short natural transition.
- Africa: lead with South Africa if a story exists.
- Korea & Asia: Korea FIRST always. Surface Korean angle in global stories where relevant (chips, trade, diplomacy).
- Science & Tech: MarginalRevolution flavor — curious, slightly nerdy, asks what this implies.
- Rugby: Stormers FIRST, then URC, then SA rugby. Keep it punchy.
- 한국어 요약: Full recap of ALL segments in Korean. TOPIK Level 3 — intermediate grammar (-(으)면서, -기 때문에, -(으)ㄹ 것이다, -았/었던), real news vocabulary, natural spoken Korean not formal written. No hanja. ~280 words.`;

async function generateScript(news) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const newsContext = Object.entries(news).map(([cat, items]) => {
    if (!items || !items.length) return '';
    return `## ${cat.toUpperCase()}\n` + items.map(i =>
      `- [${i.source}] ${i.title}${i.summary ? ': ' + i.summary : ''}`
    ).join('\n');
  }).filter(Boolean).join('\n\n');

  const fetched = Object.values(news).flat().length;
  console.log(`📰 ${fetched} stories fetched across ${Object.keys(news).length} categories`);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Today is ${today}. Write the full Briefcast script using ONLY these real stories fetched this morning:\n\n${newsContext}`
    }]
  });

  return response.content[0].text;
}

// ── Cache (one episode per day) ───────────────────────────────
let cache = { date: null, script: null, segments: null };

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function parseSegments(text) {
  const segRegex = /\[SEGMENT:\s*([^\|]+)\|\s*([^\]]+)\]/g;
  const parts = text.split(/\[SEGMENT:[^\]]+\]/);
  const labels = [], durations = [];
  let match;
  while ((match = segRegex.exec(text)) !== null) {
    labels.push(match[1].trim());
    durations.push(match[2].trim());
  }
  return labels.map((label, i) => ({
    label,
    duration: durations[i] || '',
    content: (parts[i + 1] || '').trim(),
  }));
}

// ── Routes ────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/generate', async (req, res) => {
  const force = req.body?.force === true;

  // Return cache if same day and not forced
  if (!force && cache.date === todayStr() && cache.segments) {
    return res.json({ cached: true, segments: cache.segments });
  }

  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    send({ step: 'fetch', message: 'Fetching real news from your sources...' });
    const news = await fetchAllNews();
    const count = Object.values(news).flat().length;
    send({ step: 'fetched', message: `Got ${count} stories. Writing your script...` });

    const script = await generateScript(news);
    const segments = parseSegments(script);

    cache = { date: todayStr(), script, segments };

    send({ step: 'done', segments });
    res.end();
  } catch (e) {
    console.error('Generation error:', e);
    try {
      res.write(`data: ${JSON.stringify({ step: 'error', message: e.message })}\n\n`);
      res.end();
    } catch(_) {}
  }
});

app.get('/api/today', (req, res) => {
  if (cache.date === todayStr() && cache.segments) {
    res.json({ cached: true, segments: cache.segments });
  } else {
    res.json({ cached: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎙️  Briefcast running on port ${PORT}`));
