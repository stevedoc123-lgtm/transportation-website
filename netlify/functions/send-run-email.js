/**
 * Send run request / equipment request email to the show's team.
 * Uses Resend API — emails come from noreply@filmtranspo.com
 * with reply-to set to the requestor's email.
 *
 * Set RESEND_API_KEY in Netlify environment variables.
 */

const SUPABASE_URL = 'https://dshhqozxeaetzenekzqr.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRzaGhxb3p4ZWFldHplbmVrenFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNzgwNTUsImV4cCI6MjA4OTk1NDA1NX0.qfyIW5ZAQeVbCSsZjfZ_6xdxklZW7Is-h_yuIYkB2ss';

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_API_KEY) {
        console.error('RESEND_API_KEY not set');
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Email not configured yet' }) };
    }

    try {
        const { show_slug, show_name, form_type, data } = JSON.parse(event.body);

        // Get team emails from Supabase
        const showResp = await fetch(
            `${SUPABASE_URL}/rest/v1/shows?slug=eq.${show_slug}&select=id`,
            { headers: { apikey: SUPABASE_KEY } }
        );
        const shows = await showResp.json();
        if (!shows.length) throw new Error(`Show not found: ${show_slug}`);
        const showId = shows[0].id;

        const teamResp = await fetch(
            `${SUPABASE_URL}/rest/v1/show_team?show_id=eq.${showId}&select=name,email,role`,
            { headers: { apikey: SUPABASE_KEY } }
        );
        const team = await teamResp.json();
        if (!team.length) throw new Error(`No team members for show: ${show_slug}`);

        const toEmails = team.map(t => t.email);

        // Format the date nicely
        const now = new Date();
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        const formLabel = form_type === 'run' ? 'TRANSPORTATION RUN REQUEST' : 'SPECIAL EQUIPMENT REQUEST';

        // Build email HTML to match the Tulsa King PDF style
        const fieldRows = Object.entries(data)
            .filter(([k, v]) => v && k !== 'show_slug' && k !== 'form_type')
            .map(([k, v]) => {
                const label = k.replace(/_/g, ' ').toUpperCase();
                // Style certain fields as badges
                const isBadge = ['request_type', 'payment_option', 'vehicle_type'].includes(k);
                const valHtml = isBadge
                    ? `<span style="display:inline-block;background:#e8e8e8;padding:4px 12px;border-radius:4px;font-size:14px">${v}</span>`
                    : `<span style="color:#333;font-size:15px">${v}</span>`;
                return `<tr><td style="padding:10px 16px;font-weight:700;color:#1a1a4e;font-size:13px;text-transform:uppercase;vertical-align:top;width:240px;border-bottom:1px solid #eee">${label}</td><td style="padding:10px 16px;border-bottom:1px solid #eee">${valHtml}</td></tr>`;
            })
            .join('');

        const emailHtml = `
        <div style="max-width:650px;margin:0 auto;font-family:Arial,sans-serif">
            <div style="background:#f5f5fa;padding:24px 32px;border-radius:12px 12px 0 0;display:flex;align-items:center;justify-content:space-between">
                <div>
                    <div style="font-size:24px;font-weight:800;color:#1a1a4e">${show_name}</div>
                    <div style="font-size:14px;color:#666;margin-top:2px">${formLabel}</div>
                </div>
                <div style="color:#888;font-size:13px">${dateStr}</div>
            </div>
            <div style="background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 12px 12px;overflow:hidden">
                <table style="width:100%;border-collapse:collapse">
                    ${fieldRows}
                </table>
            </div>
            <div style="text-align:center;padding:16px;color:#999;font-size:12px">
                Film Transportation Services
            </div>
        </div>`;

        // Send via Resend
        const replyTo = data.email || undefined;
        const subject = `${show_name} — ${form_type === 'run' ? 'Run Request' : 'Equipment Request'} — ${data.requestor_name || 'New Submission'}`;

        const emailResp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${RESEND_API_KEY}`,
            },
            body: JSON.stringify({
                from: 'Film Transportation <noreply@filmtranspo.com>',
                to: toEmails,
                reply_to: replyTo,
                subject: subject,
                html: emailHtml,
            }),
        });

        const emailResult = await emailResp.json();
        if (!emailResp.ok) {
            console.error('Resend error:', emailResult);
            throw new Error(emailResult.message || 'Email send failed');
        }

        return {
            statusCode: 200,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ success: true, emailed: toEmails.length }),
        };

    } catch (error) {
        console.error('Function error:', error);
        return {
            statusCode: 200,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ success: false, error: error.message }),
        };
    }
};
