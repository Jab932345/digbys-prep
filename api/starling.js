// Vercel serverless function — Starling API proxy
// Sits between the browser app and Starling to keep your token server-side
// Deploy to: api/starling.js alongside index.html

export default async function handler(req, res) {
  // CORS — allow requests from your own Vercel domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const token = process.env.STARLING_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'STARLING_TOKEN environment variable not set' });
  }

  try {
    // Step 1: get account UID
    const accountsRes = await fetch('https://api.starlingbank.com/api/v2/accounts', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    if (!accountsRes.ok) {
      const txt = await accountsRes.text();
      return res.status(accountsRes.status).json({ error: 'Starling accounts error', detail: txt });
    }
    const accountsData = await accountsRes.json();
    const account = accountsData.accounts?.[0];
    if (!account) return res.status(404).json({ error: 'No accounts found' });

    const accountUid = account.accountUid;
    const categoryUid = account.defaultCategory;

    // Step 2: work out date range
    // Default: from start of current tax year to today
    // Tax year starts 6 April — determine which one
    const now = new Date();
    const taxYearStart = now.getMonth() >= 3   // April = month 3
      ? new Date(now.getFullYear(), 3, 6)       // after Apr 6 this year
      : new Date(now.getFullYear() - 1, 3, 6); // before Apr 6, use last year
    
    // Allow override via query params: ?from=2025-04-06&to=2026-01-23
    const fromDate = req.query.from
      ? new Date(req.query.from)
      : taxYearStart;
    const toDate = req.query.to
      ? new Date(req.query.to)
      : now;

    const minTime = fromDate.toISOString();
    const maxTime = toDate.toISOString();

    // Step 3: fetch transactions
    const txUrl = `https://api.starlingbank.com/api/v2/feed/account/${accountUid}/category/${categoryUid}/transactions-between?minTransactionTimestamp=${minTime}&maxTransactionTimestamp=${maxTime}`;
    const txRes = await fetch(txUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    if (!txRes.ok) {
      const txt = await txRes.text();
      return res.status(txRes.status).json({ error: 'Starling transactions error', detail: txt });
    }
    const txData = await txRes.json();

    // Step 4: normalise to the same shape the app already understands
    const transactions = (txData.feedItems || []).map(item => ({
      date: item.transactionTime?.slice(0, 10) || '',
      counterParty: item.counterPartyName || item.reference || '',
      reference: item.reference || '',
      txType: item.source || '',
      amount: item.direction === 'IN'
        ? item.amount?.minorUnits / 100
        : -(item.amount?.minorUnits / 100),
      starlingCat: item.spendingCategory || '',
      feedItemUid: item.feedItemUid || ''
    }));

    return res.status(200).json({
      accountName: account.name || 'Main Account',
      currency: account.currency || 'GBP',
      fromDate: fromDate.toISOString().slice(0, 10),
      toDate: toDate.toISOString().slice(0, 10),
      count: transactions.length,
      transactions
    });

  } catch (err) {
    return res.status(500).json({ error: 'Proxy error', detail: err.message });
  }
}
