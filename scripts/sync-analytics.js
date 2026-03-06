/**
 * sync-analytics.js
 *
 * Runs every Monday via GitHub Actions.
 * Fetches last week's GA4 metrics and writes a new row to
 * the "Website Analytics Log" database in Notion.
 *
 * Required GitHub Secrets:
 *   NOTION_API_KEY          — from notion.so/my-integrations
 *   NOTION_ANALYTICS_DB_ID  — the ID of your "Website Analytics Log" database
 *   GA4_PROPERTY_ID         — numeric property ID from GA4 (e.g. 123456789)
 *   GA4_SERVICE_ACCOUNT_KEY — full JSON of your Google service account key
 */

const { Client } = require('@notionhq/client');
const { GoogleAuth } = require('google-auth-library');

// ─── Date helpers ────────────────────────────────────────────────────────────

function getLastWeekRange() {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0 = Sunday
  // Go back to last Monday
  const lastMonday = new Date(today);
  lastMonday.setDate(today.getDate() - dayOfWeek - 6);
  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  return {
    startDate: lastMonday.toISOString().split('T')[0],
    endDate: lastSunday.toISOString().split('T')[0],
  };
}

// ─── GA4 auth ────────────────────────────────────────────────────────────────

async function getAccessToken() {
  const keyJson = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_KEY);
  const auth = new GoogleAuth({
    credentials: keyJson,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

// ─── GA4 Data API calls ───────────────────────────────────────────────────────

async function ga4Report(accessToken, propertyId, body) {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GA4 API error: ${res.status} — ${err}`);
  }
  return res.json();
}

async function fetchMetrics(accessToken, propertyId, startDate, endDate) {
  const [mainData, topPageData, sourcesData] = await Promise.all([
    // Main metrics
    ga4Report(accessToken, propertyId, {
      dateRanges: [{ startDate, endDate }],
      metrics: [
        { name: 'totalUsers' },
        { name: 'screenPageViews' },
        { name: 'newUsers' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' },
      ],
    }),
    // Top page by views
    ga4Report(accessToken, propertyId, {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 1,
    }),
    // Traffic by channel
    ga4Report(accessToken, propertyId, {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
    }),
  ]);

  // Parse main row
  const row = mainData.rows?.[0]?.metricValues || [];
  const totalUsers = parseInt(row[0]?.value || '0');
  const pageViews = parseInt(row[1]?.value || '0');
  const newUsers = parseInt(row[2]?.value || '0');
  const bounceRate = parseFloat(row[3]?.value || '0') * 100;
  const avgDuration = parseFloat(row[4]?.value || '0');

  // Top page
  const topPage = topPageData.rows?.[0]?.dimensionValues?.[0]?.value || '/';

  // Traffic sources
  let organic = 0, social = 0, direct = 0, referral = 0;
  for (const srcRow of sourcesData.rows || []) {
    const channel = srcRow.dimensionValues[0].value.toLowerCase();
    const sessions = parseInt(srcRow.metricValues[0].value || '0');
    if (channel.includes('organic search')) organic += sessions;
    else if (channel.includes('organic social') || channel.includes('social')) social += sessions;
    else if (channel.includes('direct')) direct += sessions;
    else if (channel.includes('referral')) referral += sessions;
  }

  return {
    totalUsers,
    pageViews,
    newUsers,
    returningUsers: Math.max(0, totalUsers - newUsers),
    bounceRate: Math.round(bounceRate * 10) / 10,
    avgDuration: Math.round(avgDuration),
    topPage,
    organic,
    social,
    direct,
    referral,
  };
}

// ─── Notion write ─────────────────────────────────────────────────────────────

async function writeToNotion(startDate, metrics) {
  const notion = new Client({ auth: process.env.NOTION_API_KEY });
  const weekLabel = `Week of ${startDate}`;

  await notion.pages.create({
    parent: { database_id: process.env.NOTION_ANALYTICS_DB_ID },
    properties: {
      'Week Starting':               { title:     [{ text: { content: weekLabel } }] },
      'Week Date':                   { date:      { start: startDate } },
      'Total Visitors':              { number:    metrics.totalUsers },
      'Page Views':                  { number:    metrics.pageViews },
      'New Users':                   { number:    metrics.newUsers },
      'Returning Users':             { number:    metrics.returningUsers },
      'Top Page':                    { rich_text: [{ text: { content: metrics.topPage } }] },
      'Bounce Rate %':               { number:    metrics.bounceRate },
      'Avg Session Duration (sec)':  { number:    metrics.avgDuration },
      'Organic Search':              { number:    metrics.organic },
      'Social':                      { number:    metrics.social },
      'Direct':                      { number:    metrics.direct },
      'Referral':                    { number:    metrics.referral },
      'Auto Synced':                 { checkbox:  true },
    },
  });

  console.log(`✅ Synced "${weekLabel}" → Notion Analytics Log`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { startDate, endDate } = getLastWeekRange();
  console.log(`📊 Fetching GA4 data for ${startDate} → ${endDate}`);

  const accessToken = await getAccessToken();
  const metrics = await fetchMetrics(
    accessToken,
    process.env.GA4_PROPERTY_ID,
    startDate,
    endDate
  );

  console.log('📈 Metrics:', metrics);
  await writeToNotion(startDate, metrics);
}

main().catch((err) => {
  console.error('❌ Sync failed:', err.message);
  process.exit(1);
});
