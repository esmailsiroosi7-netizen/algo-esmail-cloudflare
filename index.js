export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("Algo Esmail TEST is running!");
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const update = await request.json();

      if (!update.message) {
        return new Response("OK");
      }

      const chatId = update.message.chat.id;
      const text = update.message.text || "";

      if (!env.BOT_TOKEN) {
        return new Response("BOT_TOKEN missing", {
          status: 500
        });
      }

      let reply = "🤖 ربات آنلاین است.";

      if (text === "/start") {
        reply = "✅ Algo Esmail V2\n\nربات با موفقیت وصل است.";
      }

      if (text === "/help") {
        reply = "📚 ربات فعال است.\n\n/start\n/help";
      }

      await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: reply
          })
        }
      );

      return new Response("OK");

    } catch (error) {
      console.error(error);

      return new Response("ERROR", {
        status: 500
      });
    }
  }
};
