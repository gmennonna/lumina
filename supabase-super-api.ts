import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendWebPush } from "https://raw.githubusercontent.com/gmennonna/lumina/main/push-crypto.js";

const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_PUBLIC_KEY  = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_SUBJECT     = "mailto:g.mennonna@gmail.com";

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // 1. Trova tutte le note pronte per la consegna
  const { data: notes, error } = await supabase
    .from("gratitude_notes")
    .select("id, recipient_id, message")
    .eq("delivered", false)
    .lte("deliver_at", new Date().toISOString());

  if (error) {
    console.error("Error fetching notes:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (!notes || notes.length === 0) {
    return new Response(JSON.stringify({ delivered: 0 }), { status: 200 });
  }

  let delivered = 0;

  for (const note of notes) {
    // 2. Controlla le preferenze del destinatario per le gratitude notes
    const { data: prefs } = await supabase
      .from("notification_prefs")
      .select("gratitude")
      .eq("user_id", note.recipient_id)
      .maybeSingle();

    const sendPush = !prefs || prefs.gratitude !== false;

    if (sendPush) {
      // 3. Trova la push subscription del destinatario
      const { data: subRow } = await supabase
        .from("push_subscriptions")
        .select("subscription")
        .eq("user_id", note.recipient_id)
        .maybeSingle();

      if (subRow?.subscription) {
        try {
          await sendWebPush(
            subRow.subscription,
            {
              title: "💌 A note for you",
              body: note.message.length > 100
                ? note.message.slice(0, 97) + "…"
                : note.message,
              url: "/lumina/"
            },
            VAPID_PUBLIC_KEY,
            VAPID_PRIVATE_KEY,
            VAPID_SUBJECT
          );
        } catch (e) {
          console.warn(`Push failed for note ${note.id}:`, (e as Error).message);
        }
      }
    }

    // 4. Marca la nota come consegnata in ogni caso
    await supabase
      .from("gratitude_notes")
      .update({ delivered: true, delivered_at: new Date().toISOString() })
      .eq("id", note.id);

    delivered++;
  }

  return new Response(JSON.stringify({ delivered }), { status: 200 });
});
