import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';

function httpsGetJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; data?: any }> {
  return new Promise((resolve) => {
    const req = https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 200, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode || 200, data: null });
        }
      });
    });
    req.on('error', () => resolve({ status: 500 }));
    req.setTimeout(4000, () => {
      req.destroy();
      resolve({ status: 504 });
    });
  });
}

async function runLiveQueueTests() {
  console.log('--- TEST 1: Read Active xStreaming Token from System ---');
  const configPath = path.join(os.homedir(), '.config/xstreaming/config.json');
  assert(fs.existsSync(configPath), `Config file must exist at ${configPath}`);

  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  const gsToken = config.user?.streamToken?.xCloudToken?.data?.gsToken;
  assert(typeof gsToken === 'string' && gsToken.length > 50, 'gsToken must be a valid non-empty JWT string');
  console.log('Confirmed: Valid xStreaming gsToken found with length:', gsToken.length);

  console.log('\n--- TEST 2: Query Live Wait Time from Azure brazilsouth (Barueri / SP) ---');
  const headers = {
    Authorization: `Bearer ${gsToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)',
    Origin: 'https://www.xbox.com',
    Referer: 'https://www.xbox.com/',
  };

  const waitRes = await httpsGetJson('https://brs.core.gssv-play-prod.xboxlive.com/v1/waittime/NOMANSSKY', headers);
  assert.strictEqual(waitRes.status, 200, `Expected HTTP 200 from wait time endpoint, got ${waitRes.status}`);
  assert(typeof waitRes.data?.estimatedTotalWaitTimeInSeconds === 'number', 'estimatedTotalWaitTimeInSeconds must be a number');
  assert(waitRes.data.estimatedTotalWaitTimeInSeconds >= 0, 'estimatedTotalWaitTimeInSeconds must be >= 0');
  console.log('Confirmed: Live wait time for NOMANSSKY:', waitRes.data.estimatedTotalWaitTimeInSeconds, 'seconds');

  console.log('\n--- TEST 3: Query Display Catalog Metadata (Titles & BoxArt) ---');
  const catalogRes = await httpsGetJson(
    'https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=BQVQTL3PCH05,BT5P2X999VH2&market=BR&languages=pt-BR',
    { 'User-Agent': 'Mozilla/5.0' }
  );
  assert.strictEqual(catalogRes.status, 200, 'Display catalog must return 200');
  assert(Array.isArray(catalogRes.data?.Products), 'Products must be an array');
  const productTitles = catalogRes.data.Products.map((p: any) => p.LocalizedProperties?.[0]?.ProductTitle);
  console.log('Resolved Product Titles:', productTitles);
  assert(productTitles.length >= 2, 'Should resolve at least 2 product titles');

  console.log('\n✅ ALL LIVE QUEUE INTEGRATION TESTS PASSED SUCCESSFULLY!');
}

runLiveQueueTests().catch((err) => {
  console.error('Test failure:', err);
  process.exit(1);
});
