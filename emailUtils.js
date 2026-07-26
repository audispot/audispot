const { Resend } = require("resend");

function safeStr(v) {
  return String(v ?? "").trim();
}

let resendClient = null;

function getResendClient() {
  if (resendClient) return resendClient;
  
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Missing RESEND_API_KEY environment variable");

  resendClient = new Resend(key);
  return resendClient;
}

async function sendEmail({ to, subject, text, html }) {
  const resend = getResendClient();

  const from = safeStr(process.env.RESEND_SENDER_EMAIL || "noreply@mail.audispot.audiory.site");
  if (!from) throw new Error("Missing RESEND_SENDER_EMAIL environment variable");

  const result = await resend.emails.send({
    from,
    to,
    subject,
    text: text || "",
    html: html || "",
  });

  if (result?.error) {
    throw new Error(result.error.message || "Failed to send email");
  }

  return result;
}

module.exports = {
  safeStr,
  sendEmail,
};
