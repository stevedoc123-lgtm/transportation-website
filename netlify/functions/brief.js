/**
 * POST /.netlify/functions/brief
 *
 * Pulls today's screener ideas from Supabase, formats an HTML brief,
 * sends it to Steve via Resend, and logs the brief into research_briefs.
 *
 * Auth: requires X-Trigger-Token matching SCREENER_TOKEN env var (or
 * SUPABASE_SERVICE_ROLE_KEY as fallback).
 *
 * Required env: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY
 */

const SUPABASE_URL = 'https://dshhqozxeaetzenekzqr.supabase.co';
const RECIPIENT = 'stevedoc123@gmail.com';

async function sb(path, opts = {}) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...opts,
        headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
        },
    });
    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Supabase ${path} ${resp.status}: ${txt.slice(0, 200)}`);
    }
    return resp.json();
}

function ideaCardHtml(idea) {
    const bias = idea.tags?.includes('bearish') ? 'BEARISH' : (idea.tags?.includes('bullish') ? 'BULLISH' : '');
    const biasColor = bias === 'BEARISH' ? '#dc2626' : '#059669';
    return `
    <table style="width:100%;border-collapse:collapse;margin-bottom:14px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <tr style="background:#f9fafb">
        <td style="padding:10px 14px">
          <span style="font-size:18px;font-weight:800;color:#111;letter-spacing:1px">${idea.symbol}</span>
          ${bias ? `<span style="margin-left:10px;display:inline-block;background:${biasColor};color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:10px;letter-spacing:1px">${bias}</span>` : ''}
        </td>
      </tr>
      <tr>
        <td style="padding:12px 14px;font-size:13px;color:#333;line-height:1.5">
          <div style="margin-bottom:8px"><strong style="color:#111">Thesis:</strong> ${idea.thesis || '—'}</div>
          <div><strong style="color:#111">Invalidates:</strong> ${idea.invalidation || '—'}</div>
        </td>
      </tr>
    </table>`;
}

exports.handler = async (event) => {
    const trigger = event.headers['x-trigger-token'] || event.headers['X-Trigger-Token'];
    const expected = process.env.SCREENER_TOKEN || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!expected || trigger !== expected) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };
    }
    if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_API_KEY) {
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'RESEND_API_KEY not set' }) };
    }

    try {
        // Pull current ideas (status='idea') created in the last 36 hours
        const cutoff = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
        const ideas = await sb(`trade_ideas?status=eq.idea&created_at=gte.${cutoff}&order=created_at.desc&select=*`);

        if (!ideas.length) {
            return {
                statusCode: 200,
                body: JSON.stringify({ ok: true, sent: false, reason: 'No fresh ideas to brief' }),
            };
        }

        const bearish = ideas.filter(i => i.tags?.includes('bearish'));
        const bullish = ideas.filter(i => i.tags?.includes('bullish'));

        const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

        const html = `
        <div style="max-width:680px;margin:0 auto;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#111">
          <div style="background:#1a1a2e;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0">
            <div style="font-size:11px;letter-spacing:3px;color:#9ca3af;text-transform:uppercase">Trading Brief</div>
            <div style="font-size:22px;font-weight:800;margin-top:4px">${dateStr}</div>
            <div style="font-size:13px;color:#cbd5e1;margin-top:2px">Screener v1 — directional ideas only. Reply with which symbols to design a structure for.</div>
          </div>
          <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:18px 22px">

            ${bearish.length ? `
            <h3 style="margin:0 0 12px;color:#dc2626;font-size:14px;text-transform:uppercase;letter-spacing:2px;border-bottom:1px solid #fee2e2;padding-bottom:6px">Bearish Setups (${bearish.length})</h3>
            ${bearish.map(ideaCardHtml).join('')}
            ` : ''}

            ${bullish.length ? `
            <h3 style="margin:18px 0 12px;color:#059669;font-size:14px;text-transform:uppercase;letter-spacing:2px;border-bottom:1px solid #d1fae5;padding-bottom:6px">Bullish Setups (${bullish.length})</h3>
            ${bullish.map(ideaCardHtml).join('')}
            ` : ''}

            <div style="margin-top:24px;padding:14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:12px;color:#78350f;line-height:1.5">
              <strong>How to respond:</strong> Reply with the symbols you'd like to design specific options structures for (e.g. "approve TSLA put debit spread, NVDA long call"). Max risk per trade: $125. Defined-risk structures only — no naked options.
            </div>

          </div>
          <div style="text-align:center;color:#9ca3af;font-size:11px;padding:14px">
            Generated automatically. Paper account ${process.env.ALPACA_BASE_URL?.includes('paper') ? '(paper)' : '(LIVE — careful)'}.
          </div>
        </div>`;

        const subject = `Trading Brief — ${ideas.length} ideas (${bearish.length}↓ / ${bullish.length}↑) — ${dateStr}`;

        const emailResp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${RESEND_API_KEY}`,
            },
            body: JSON.stringify({
                from: 'Trading Brief <noreply@filmtranspo.com>',
                to: [RECIPIENT],
                subject,
                html,
            }),
        });
        const emailResult = await emailResp.json();
        if (!emailResp.ok) {
            console.error('Resend error:', emailResult);
            throw new Error(emailResult.message || 'Email send failed');
        }

        // Log the brief
        const briefRow = {
            sent_at: new Date().toISOString(),
            market_read: 'mixed',
            summary: `${bearish.length} bearish + ${bullish.length} bullish from screener_v1`,
            idea_ids: ideas.map(i => i.id),
        };
        await fetch(`${SUPABASE_URL}/rest/v1/research_briefs`, {
            method: 'POST',
            headers: {
                apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
            },
            body: JSON.stringify(briefRow),
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                sent: true,
                to: RECIPIENT,
                subject,
                ideas_count: ideas.length,
                bearish_count: bearish.length,
                bullish_count: bullish.length,
                resend_id: emailResult.id,
            }, null, 2),
        };
    } catch (err) {
        console.error('brief error', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
    }
};
