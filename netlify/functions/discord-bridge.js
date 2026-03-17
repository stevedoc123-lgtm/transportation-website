exports.handler = async (event, context) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      }
    };
  }

  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }

  const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1481812099259826370/I__eWBIYtXWDF39iylv9iNBlG6sJIUxegIT0fmIMoHO-2Ukj8GYaHfEUXju-BLW6_lpT';

  try {
    const payload = JSON.parse(event.body);
    
    // Determine form type from payload
    const formName = payload.data?.form_name || payload.form_name || 'unknown';
    const formData = payload.data || payload;
    
    let title = '📋 New Form Submission';
    let color = 0x3498db;
    
    if (formName === 'run-request' || formName.includes('run')) {
      title = '🚛 New Run Request';
      color = 0xe94560;
    } else if (formName === 'equipment-request' || formName.includes('equipment')) {
      title = '🎬 New Equipment Request';
      color = 0x9b59b6;
    }

    // Build fields from form data
    const fields = [];
    for (const [key, value] of Object.entries(formData)) {
      if (key && value && 
          !['form-name', 'form_id', 'site_url', 'submission_id'].includes(key) &&
          typeof value === 'string' && value.trim()) {
        const cleanKey = key.replace(/_/g, ' ').replace(/\[\]/g, '').toUpperCase();
        fields.push({
          name: cleanKey.substring(0, 256),
          value: value.substring(0, 1024),
          inline: value.length < 50
        });
      }
    }

    // Limit fields to 25 (Discord max)
    const limitedFields = fields.slice(0, 25);

    const embed = {
      title: title,
      description: `New submission from ${payload.data?.requestor_name || 'Unknown'}`,
      color: color,
      timestamp: new Date().toISOString(),
      fields: limitedFields,
      footer: {
        text: 'Film Transportation Services'
      }
    };

    // Send to Discord
    const response = await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] })
    });

    if (!response.ok) {
      console.error('Discord webhook failed:', response.status, await response.text());
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true, message: 'Notification sent' })
    };

  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: false, error: error.message })
    };
  }
};
