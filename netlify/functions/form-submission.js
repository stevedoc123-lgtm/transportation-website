exports.handler = async (event, context) => {
  // Only process POST requests from form submissions
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Discord webhook URL for transport-alerts channel
  const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1481812099259826370/I__eWBIYtXWDF39iylv9iNBlG6sJIUxegIT0fmIMoHO-2Ukj8GYaHfEUXju-BLW6_lpT';

  try {
    // Parse the form data
    const formData = new URLSearchParams(event.body);
    const formName = formData.get('form-name') || 'unknown';
    
    // Build the Discord message
    let embed = {
      title: '🎬 New Form Submission',
      color: 0xe94560,
      timestamp: new Date().toISOString(),
      fields: []
    };

    // Add form fields to embed
    for (const [key, value] of formData.entries()) {
      if (key !== 'form-name' && key !== 'bot-field' && value) {
        const cleanKey = key.replace(/_/g, ' ').replace(/\[\]/g, '').toUpperCase();
        embed.fields.push({
          name: cleanKey,
          value: value.length > 1000 ? value.substring(0, 1000) + '...' : value,
          inline: false
        });
      }
    }

    // Add form type indicator
    if (formName === 'run-request') {
      embed.title = '🚛 New Run Request';
    } else if (formName === 'equipment-request') {
      embed.title = '🎬 New Equipment Request';
    }

    // Send to Discord
    const response = await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] })
    });

    if (!response.ok) {
      console.error('Discord webhook failed:', await response.text());
    }

    // Return success - form submission continues normally
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true })
    };

  } catch (error) {
    console.error('Function error:', error);
    // Still return 200 so form submission isn't blocked
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true })
    };
  }
};
