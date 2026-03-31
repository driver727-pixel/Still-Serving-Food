export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const neighborhood = url.searchParams.get("location");
  const userId = url.searchParams.get("userId"); // Assume you pass a userId from the frontend

  if (!neighborhood) {
    return new Response(JSON.stringify({ error: "Location parameter is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // 1. Check Pro Status in KV (Fast check)
    let isPro = false;
    if (userId) {
      const userStatus = await env.USER_SESSIONS.get(userId);
      isPro = userStatus === 'pro';
    }

    // 2. Fetch data from D1
    const { results } = await env.DB.prepare(
      "SELECT * FROM venues WHERE neighborhood = ? ORDER BY is_promoted DESC"
    )
    .bind(neighborhood)
    .all();

    // 3. Apply "Pro" logic to the results
    const responseData = results.map(venue => {
      // If NOT pro, you might want to keep ads or limit data
      if (!isPro) {
        // Example: Add an 'ad' property or filter out premium fields
        return { ...venue, ads_enabled: true };
      }
      // If IS pro, remove ads
      const { ad_banner, ...cleanVenue } = venue; 
      return { ...cleanVenue, ads_enabled: false };
    });

    return new Response(JSON.stringify(responseData), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
