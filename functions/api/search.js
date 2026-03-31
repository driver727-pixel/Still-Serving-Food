// functions/api/search.js
const neighborhood = url.searchParams.get("location");

if (!neighborhood) {
  return new Response(JSON.stringify({ error: "Location parameter is required" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}
export async function onRequest(context) {
  const { env, request } = context;
  
  // 1. Get the neighborhood from the URL params (e.g., /api/search?location=Brooklyn)
  const url = new URL(request.url);
  const neighborhood = url.searchParams.get("location");

  try {
    // 2. This is the "Promoted" logic we discussed
    // It queries your D1 database (env.DB) and sorts by 'is_promoted' first
    const { results } = await env.DB.prepare(
      "SELECT * FROM venues WHERE neighborhood = ? ORDER BY is_promoted DESC"
    )
    .bind(neighborhood)
    .all();

    // 3. Return the results as JSON to your frontend
    return new Response(JSON.stringify(results), {
      headers: { "Content-Type": "application/json" },
    });
    
  } catch (e) {
    return new Response(e.message, { status: 500 });
  }
}
