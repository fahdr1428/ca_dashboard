import { prisma } from "@/lib/db";
import { formatGBP } from "@/lib/wealth";
import type { WeeklyReportPayload } from "./weekly";

/**
 * Monday-morning delivery.
 *
 * Two transports, both optional and both configured by environment variable:
 *
 *   REPORT_WEBHOOK_URL  — POSTs the report as JSON. Works with Slack, Teams,
 *                         Zapier, or anything else that accepts a webhook.
 *   RESEND_API_KEY +    — sends the report by email via Resend's HTTP API.
 *   REPORT_EMAIL_TO       No SMTP dependency, so it works on serverless.
 *
 * If neither is set the report is still generated and stored; it just waits in
 * the dashboard. That is a deliberate default — the system should never be
 * silently dependent on an unconfigured mail provider.
 */
export async function deliverWeeklyReport(
  reportId: string,
  origin: string,
): Promise<{ delivered: boolean; detail: string }> {
  const report = await prisma.weeklyReport.findUnique({ where: { id: reportId } });
  if (!report) return { delivered: false, detail: "report not found" };

  const payload = report.payload as unknown as WeeklyReportPayload;
  const url = `${origin}/reports/${report.id}`;
  const attempts: string[] = [];
  let delivered = false;

  const webhook = process.env.REPORT_WEBHOOK_URL;
  if (webhook) {
    try {
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: slackSummary(payload, url),
          weekStart: payload.weekStart,
          totals: payload.totals,
          newProspects: payload.newProspects.map((p) => ({
            name: p.fullName,
            company: p.companyName,
            region: p.regionLabel,
            estimatedInvestableGBP: p.estInvestableMidGBP,
            confidence: p.confidence,
            note: "Modelled estimate, not a verified figure.",
          })),
          url,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      attempts.push(`webhook ${res.status}`);
      if (res.ok) delivered = true;
    } catch (err) {
      attempts.push(`webhook failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const resendKey = process.env.RESEND_API_KEY;
  const to = process.env.REPORT_EMAIL_TO;
  if (resendKey && to) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.REPORT_EMAIL_FROM ?? "Lead Intelligence <onboarding@resend.dev>",
          to: to.split(",").map((t) => t.trim()),
          subject: `Lead intelligence — week of ${new Date(payload.weekStart).toLocaleDateString("en-GB")}`,
          html: emailHtml(payload, url),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      attempts.push(`email ${res.status}`);
      if (res.ok) delivered = true;
    } catch (err) {
      attempts.push(`email failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!webhook && !(resendKey && to)) {
    return {
      delivered: false,
      detail:
        "No delivery channel configured. Set REPORT_WEBHOOK_URL, or RESEND_API_KEY and REPORT_EMAIL_TO.",
    };
  }

  if (delivered) {
    await prisma.weeklyReport.update({
      where: { id: reportId },
      data: { deliveredAt: new Date() },
    });
  }

  return { delivered, detail: attempts.join("; ") };
}

function slackSummary(p: WeeklyReportPayload, url: string): string {
  const lines = [
    `*Lead intelligence — week of ${new Date(p.weekStart).toLocaleDateString("en-GB")}*`,
    `${p.totals.newThisWeek} new prospects · ${p.totals.qualifying} qualifying · ${formatGBP(
      p.totals.addressableGBP,
    )} estimated addressable assets · ${p.totals.signalsThisWeek} signals`,
  ];
  if (p.newProspects.length) {
    lines.push("", "*New this week*");
    for (const n of p.newProspects.slice(0, 5)) {
      lines.push(
        `• ${n.fullName}${n.companyName ? ` (${n.companyName})` : ""}, ${n.regionLabel} — ${formatGBP(
          n.estInvestableMidGBP,
        )} est. investable, confidence ${n.confidence}`,
      );
    }
  }
  const notable = p.changes.filter((c) => c.magnitudeGBP && Math.abs(c.magnitudeGBP) > 1_000_000);
  if (notable.length) {
    lines.push("", "*Notable changes*");
    for (const c of notable.slice(0, 5)) {
      lines.push(`• ${c.fullName}: ${c.headline}`);
    }
  }
  lines.push("", `Full report: ${url}`, "_All figures are modelled estimates, not verified wealth._");
  return lines.join("\n");
}

function emailHtml(p: WeeklyReportPayload, url: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const newRows = p.newProspects
    .map(
      (n) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e3e1db;">
          <strong>${esc(n.fullName)}</strong>${n.jobTitle ? `, ${esc(n.jobTitle)}` : ""}<br>
          <span style="color:#7c8288;font-size:12px;">${esc(n.companyName ?? "—")} · ${esc(n.regionLabel)}</span>
        </td>
        <td style="padding:8px 10px;border-bottom:1px solid #e3e1db;text-align:right;white-space:nowrap;">
          ${formatGBP(n.estInvestableMidGBP)}<br>
          <span style="color:#7c8288;font-size:12px;">confidence ${n.confidence}</span>
        </td>
      </tr>`,
    )
    .join("");

  const changeRows = p.changes
    .slice(0, 15)
    .map(
      (c) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e3e1db;font-size:13px;">
          <strong>${esc(c.fullName)}</strong> — ${esc(c.headline)}
          ${c.sourceUrl ? ` <a href="${esc(c.sourceUrl)}" style="color:#0f766e;">source</a>` : ""}
        </td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f7f6f3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1c1e;">
<div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e3e1db;border-radius:12px;overflow:hidden;">
  <div style="padding:20px 20px 12px;">
    <h1 style="margin:0;font-size:18px;">Lead intelligence</h1>
    <p style="margin:4px 0 0;color:#7c8288;font-size:13px;">
      Week of ${new Date(p.weekStart).toLocaleDateString("en-GB")}
    </p>
  </div>
  <div style="padding:0 20px 16px;font-size:14px;">
    <strong>${p.totals.newThisWeek}</strong> new prospects ·
    <strong>${p.totals.qualifying}</strong> qualifying ·
    <strong>${formatGBP(p.totals.addressableGBP)}</strong> estimated addressable assets ·
    <strong>${p.totals.signalsThisWeek}</strong> signals
  </div>

  ${
    newRows
      ? `<h2 style="margin:0;padding:12px 20px 6px;font-size:14px;border-top:1px solid #e3e1db;">New prospects</h2>
         <table style="width:100%;border-collapse:collapse;">${newRows}</table>`
      : `<p style="padding:12px 20px;color:#7c8288;font-size:13px;border-top:1px solid #e3e1db;">No new prospects this week.</p>`
  }

  ${
    changeRows
      ? `<h2 style="margin:0;padding:16px 20px 6px;font-size:14px;border-top:1px solid #e3e1db;">Changes to existing prospects</h2>
         <table style="width:100%;border-collapse:collapse;">${changeRows}</table>`
      : ""
  }

  <div style="padding:16px 20px;">
    <a href="${esc(url)}" style="display:inline-block;background:#0f766e;color:#fff;padding:9px 14px;border-radius:8px;text-decoration:none;font-size:14px;">
      Open the full report
    </a>
  </div>

  <div style="padding:12px 20px 18px;border-top:1px solid #e3e1db;color:#7c8288;font-size:11px;line-height:1.5;">
    All wealth figures are modelled estimates derived from publicly available sources, principally
    the Companies House register. They are not verified statements of any individual's wealth and
    must not be presented to a client as fact.
  </div>
</div>
</body></html>`;
}
