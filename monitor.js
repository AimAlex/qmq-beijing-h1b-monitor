import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const CONFIG = {
  city: '北京',
  visaType: 'H-1B',
  startDate: '2026-11-01',
  endDate: '2026-11-15',
  source: 'https://qmq.app/',
};

const normalize = (value) => value.replace(/\s+/g, ' ').trim();
const excluded = (value) =>
  /官方\s*(紧急|加急)\s*(申请|预约)|紧急\s*申请|Emergency\s*Request/i.test(value);

const result = {
  checkedAt: new Date().toISOString(),
  config: CONFIG,
  status: 'unknown',
  matches: [],
  note: '',
  diagnostics: {},
};

const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 1200 },
  });

  const response = await page.goto(CONFIG.source, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  result.diagnostics.httpStatus = response?.status() ?? null;
  result.diagnostics.server = response?.headers()['server'] ?? null;
  result.diagnostics.cfRay = response?.headers()['cf-ray'] ?? null;
  result.diagnostics.finalUrl = page.url();
  result.diagnostics.title = await page.title();
  await page.getByRole('heading', { name: '当前可预约面签位', exact: true })
    .waitFor({ state: 'visible', timeout: 30_000 });

  const acknowledgement = page.getByRole('button', { name: /我已知悉/ });
  if (await acknowledgement.isVisible().catch(() => false)) await acknowledgement.click();

  const cityLabel = page.getByText(CONFIG.city, { exact: true }).last();
  await cityLabel.waitFor({ state: 'visible', timeout: 15_000 });
  const cityCard = cityLabel.locator(
    'xpath=ancestor::*[.//button[contains(normalize-space(.), "查看可预约日期")]][1]'
  );
  const reveal = cityCard.getByRole('button', { name: /查看可预约日期/ });
  await reveal.click();

  await page.waitForTimeout(15_000);

  const section = await page.evaluate(() => {
    const headings = [...document.querySelectorAll('h2')];
    const start = headings.find((node) => node.textContent?.includes('当前可预约面签位'));
    if (!start) return '';
    const chunks = [];
    let node = start.parentElement?.nextElementSibling ?? start.nextElementSibling;
    while (node) {
      if (node.matches?.('h2') || node.querySelector?.('h2')) {
        const nextHeading = node.matches?.('h2') ? node : node.querySelector('h2');
        if (nextHeading?.textContent?.includes('常见问题')) break;
      }
      chunks.push(node.innerText || '');
      node = node.nextElementSibling;
    }
    return chunks.join('\n');
  });

  const visibleText = normalize(section || await cityCard.innerText());
  const verificationBlocked = /人机验证|防止恶意抓取|验证码|captcha|verify you are human/i
    .test(visibleText);

  const dateRegex = /20\d{2}[-\/]\d{2}[-\/]\d{2}/g;
  const candidates = await page.locator('body *').evaluateAll((elements) =>
    elements
      .filter((element) => element.children.length <= 8)
      .map((element) => (element.innerText || '').trim())
      .filter((text) => text && text.length <= 500)
  );

  const unique = new Map();
  for (const raw of candidates) {
    const text = normalize(raw);
    if (!text.includes(CONFIG.city) || !text.includes(CONFIG.visaType) || excluded(text)) continue;
    for (const rawDate of text.match(dateRegex) || []) {
      const date = rawDate.replaceAll('/', '-');
      if (date < CONFIG.startDate || date > CONFIG.endDate) continue;
      const key = `${date}|${text}`;
      unique.set(key, { city: CONFIG.city, visaType: CONFIG.visaType, date, context: text });
    }
  }

  result.matches = [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (result.matches.length) {
    result.status = 'available';
    result.note = 'Found matching dynamically rendered appointment slots.';
  } else if (verificationBlocked) {
    result.status = 'verification_blocked';
    result.note = 'QMQ required human verification; the monitor did not bypass it.';
  } else {
    result.status = 'none';
    result.note = 'No matching current appointment slots were found.';
  }
} catch (error) {
  result.status = 'error';
  result.note = error instanceof Error ? error.message : String(error);
  if (page) {
    result.diagnostics.finalUrl = page.url();
    result.diagnostics.title = await page.title().catch(() => null);
    const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    result.diagnostics.bodyText = normalize(bodyText).slice(0, 4_000);
    const probe = `${result.diagnostics.title || ''} ${result.diagnostics.bodyText || ''}`;
    result.diagnostics.detectedBlock =
      /cloudflare|cf-ray|checking your browser|just a moment/i.test(probe) ? 'cloudflare_challenge' :
      /人机验证|验证码|captcha|verify you are human|verification/i.test(probe) ? 'human_verification' :
      /access denied|forbidden|blocked|拒绝访问|禁止访问/i.test(probe) ? 'access_denied' :
      'unknown';
    await writeFile('diagnostic.html', await page.locator('html').evaluate((el) => el.outerHTML).catch(() => ''));
    await page.screenshot({ path: 'diagnostic.png', fullPage: true }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile('result.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
