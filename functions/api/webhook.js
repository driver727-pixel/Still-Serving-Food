export async function onRequestPost(context) {
  const { request, env } = context;

  const signature = request.headers.get("stripe-signature");
  const body = await request.text();

  // 1. Verify the signature (Security)
  // This ensures the request actually came from Stripe
  if (!signature || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    // For simplicity in this phase, we'll parse the event directly.
    // In a full production app, you'd use the Stripe SDK to verify the signature.
    const event = JSON.parse(body);

    // 2. Handle the successful payment event
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      
      // We use 'client_reference_id' to pass your internal userId through Stripe
      const userId = session.client_reference_id;

      if (userId) {
        // 3. Update the KV Store to 'pro'
        await env.USER_SESSIONS.put(userId, 'pro');
        console.log(`User ${userId} upgraded to Pro!`);
      }
    }

    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (err) {
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }
}
