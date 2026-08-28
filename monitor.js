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
  targetStatus: 'unknown',
  matches: [],
  currentAvailable: [],
  currentAvailableCount: null,
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

  const verificationNetwork = [];
  const failedRequests = [];
  const browserErrors = [];
  page.on('response', (response) => {
    const url = response.url();
    if (/qmq\.app|geetest|captcha|verify/i.test(url)) {
      verificationNetwork.push({ url, status: response.status() });
    }
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (/qmq\.app|geetest|captcha|verify/i.test(url)) {
      failedRequests.push({ url, error: request.failure()?.errorText ?? 'unknown' });
    }
  });
  page.on('pageerror', (error) => browserErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });

  const response = await page.goto(CONFIG.source, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  result.diagnostics.httpStatus = response?.status() ?? null;
  result.diagnostics.server = response?.headers()['server'] ?? null;
  result.diagnostics.cfRay = response?.headers()['cf-ray'] ?? null;
  result.diagnostics.finalUrl = page.url();
  result.diagnostics.title = await page.title();

  const acknowledgement = page.getByRole('button', { name: /我已知悉/ });
  if (await acknowledgement.isVisible({ timeout: 5_000 }).catch(() => false)) {
    result.diagnostics.announcementModal = true;
    await acknowledgement.click();
  } else {
    result.diagnostics.announcementModal = false;
  }

  await page.getByRole('heading', { name: '当前可预约面签位', exact: true })
    .waitFor({ state: 'visible', timeout: 30_000 });

  const cityLabel = page.getByText(CONFIG.city, { exact: true }).last();
  await cityLabel.waitFor({ state: 'visible', timeout: 15_000 });
  const cityCard = cityLabel.locator(
    'xpath=ancestor::*[.//button[contains(normalize-space(.), "查看可预约日期")]][1]'
  );
  const reveal = cityCard.getByRole('button', { name: /查看可预约日期/ });
  await reveal.click();

  await page.waitForTimeout(30_000);

  const cityCardText = await cityCard.innerText().catch(() => '');
  const dialogs = await page.locator('[role="dialog"]:visible').allInnerTexts().catch(() => []);
  const availabilityText = [cityCardText, ...dialogs].filter(Boolean).join('\n');
  result.currentAvailableCount = Number(
    cityCardText.match(new RegExp(`${CONFIG.city}\\s+(\\d+)\\s*个可用日期`))?.[1] ?? NaN
  );
  if (!Number.isFinite(result.currentAvailableCount)) result.currentAvailableCount = null;
  result.diagnostics.cityCardText = normalize(cityCardText).slice(0, 2_000);
  result.diagnostics.visibleDialogs = dialogs.map(normalize).slice(0, 5);
  result.diagnostics.verificationNetwork = verificationNetwork.slice(-100);
  result.diagnostics.failedRequests = failedRequests.slice(-50);
  result.diagnostics.browserErrors = browserErrors.slice(-50);
  const verificationBlocked = /人机验证|无感验证|防止恶意抓取|验证码|captcha|verify you are human/i
    .test(availabilityText);

  const dateRegex = /20\d{2}[-\/]\d{2}[-\/]\d{2}/g;
  const candidates = availabilityText.split(/\n+/).map(normalize).filter(Boolean);

  const unique = new Map();
  for (const raw of candidates) {
    const text = normalize(raw);
    if (excluded(text)) continue;
    for (const rawDate of text.match(dateRegex) || []) {
      const date = rawDate.replaceAll('/', '-');
      const key = `${date}|${text}`;
      const visaType = text.match(/\b(?:H-1B|H-4|L-1|L-2|O-1|F-1|F-2|J-1|J-2|B1\/B2|K-1|C1\/D)\b/i)?.[0] ?? '未标明';
      unique.set(key, { city: CONFIG.city, visaType, date, context: text });
    }
  }

  result.currentAvailable = [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
  result.matches = result.currentAvailable.filter((slot) =>
    slot.visaType.toUpperCase() === CONFIG.visaType &&
    slot.date >= CONFIG.startDate &&
    slot.date <= CONFIG.endDate
  );
  if (result.matches.length) {
    result.status = 'available';
    result.targetStatus = 'available';
    result.note = 'Found matching dynamically rendered appointment slots.';
  } else if (verificationBlocked) {
    result.status = 'verification_blocked';
    result.targetStatus = 'unknown_verification_required';
    result.note = 'QMQ did not expose the date list because human verification is still required; the monitor did not bypass it.';
  } else {
    result.status = 'none';
    result.targetStatus = 'none';
    result.note = `No target match was found. QMQ exposed ${result.currentAvailable.length} current Beijing slot entries.`;
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
  const targetLine = result.targetStatus === 'available'
    ? `发现 ${result.matches.length} 个目标预约位：${result.matches.map((slot) => `${slot.date} ${slot.visaType}`).join('、')}`
    : result.targetStatus === 'none'
      ? `未发现 ${CONFIG.startDate} 至 ${CONFIG.endDate} 的北京 ${CONFIG.visaType} 可预约位`
      : `暂时无法判定 ${CONFIG.startDate} 至 ${CONFIG.endDate} 的北京 ${CONFIG.visaType} 是否有位（QMQ 要求人机验证）`;
  const currentLines = result.currentAvailable.length
    ? result.currentAvailable.map((slot) => `- ${slot.date} · ${slot.visaType} · ${slot.context}`).join('\n')
    : result.currentAvailableCount !== null
      ? `- QMQ 当前显示北京共有 **${result.currentAvailableCount} 个可用日期**；具体日期被人机验证保护，云端未取得日期列表。`
      : '- 未读取到公开的具体日期（如状态为 verification_blocked，表示 QMQ 要求完成人机验证）';
  await writeFile('summary.md', `## QMQ 北京预约位监控\n\n**目标结果：${targetLine}**\n\n### 当前可预约位\n\n${currentLines}\n\n状态：${result.status}\n\n${result.note}\n`);
  console.log(JSON.stringify(result, null, 2));
}
