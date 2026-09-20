/**
 * Inbound WhatsApp handling
 *
 * Customers arrive here after tapping the wa.me link in an Instagram DM, so
 * their first message carries the campaign's tracked-link slug. That slug is
 * what attributes the chat to a post, campaign and Instagram account.
 *
 * Auto-replies only ever go to someone who messaged first, and only once per
 * lead — the gateway drives an unofficial WhatsApp client, and unsolicited
 * sending is what gets a number banned.
 */

import { prisma } from "@/lib/db/client";
import { renderMessageWithoutLink } from "@/lib/tracking/message";
import { chatIdToPhone, extractRefSlug } from "@/lib/whatsapp/ref";
import {
  getWhatsAppProvider,
  WhatsAppProviderError,
} from "@/lib/whatsapp/provider";

export interface InboundWhatsAppMessage {
  id?: string;
  chatId?: string;
  from?: string;
  body?: string;
  fromMe?: boolean;
  isGroup?: boolean;
  isStatusBroadcast?: boolean;
  senderPhone?: string | null;
  contact?: { name?: string | null; pushname?: string | null } | null;
}

export type InboundResult =
  | { status: "ignored"; reason: string }
  | { status: "recorded"; leadId: string; replied: boolean };

export async function handleInboundWhatsAppMessage(
  message: InboundWhatsAppMessage,
  /** OpenWA session the message arrived on — i.e. which of your numbers. */
  sessionId?: string
): Promise<InboundResult> {
  const chatId = message.chatId ?? message.from;
  if (!chatId) return { status: "ignored", reason: "no chat id" };
  if (message.fromMe) return { status: "ignored", reason: "outgoing message" };
  if (message.isGroup || message.isStatusBroadcast) {
    return { status: "ignored", reason: "group or status broadcast" };
  }

  const body = message.body ?? "";
  const refSlug = extractRefSlug(body);

  const trackedLink = refSlug
    ? await prisma.trackedLink.findUnique({
        where: { slug: refSlug },
        select: {
          id: true,
          workspaceId: true,
          automationId: true,
          automation: {
            select: {
              id: true,
              isActive: true,
              instagramAccountId: true,
              dmMessage: true,
              openingDmMessage: true,
            },
          },
        },
      })
    : null;

  const existingLead = await prisma.whatsAppLead.findFirst({
    where: { chatId },
    select: { id: true, workspaceId: true, automationId: true },
  });

  // Without a ref and without a prior chat there is nothing to attribute this
  // to — recording it would mean inventing a workspace.
  if (!trackedLink && !existingLead) {
    return { status: "ignored", reason: "no ref and no known chat" };
  }

  const workspaceId = trackedLink?.workspaceId ?? existingLead!.workspaceId;
  const now = new Date();
  const displayName =
    message.contact?.name?.trim() || message.contact?.pushname?.trim() || null;

  const lead = await prisma.whatsAppLead.upsert({
    where: { workspaceId_chatId: { workspaceId, chatId } },
    create: {
      workspaceId,
      chatId,
      sessionId: sessionId ?? null,
      phone: message.senderPhone ?? chatIdToPhone(chatId),
      displayName,
      refSlug,
      automationId: trackedLink?.automationId ?? null,
      instagramAccountId: trackedLink?.automation?.instagramAccountId ?? null,
      trackedLinkId: trackedLink?.id ?? null,
      lastInboundAt: now,
    },
    update: {
      lastInboundAt: now,
      ...(sessionId ? { sessionId } : {}),
      ...(displayName ? { displayName } : {}),
      // First ref wins: a later message shouldn't re-attribute an existing lead.
      ...(trackedLink && !existingLead?.automationId
        ? {
            refSlug,
            automationId: trackedLink.automationId,
            instagramAccountId: trackedLink.automation?.instagramAccountId ?? null,
            trackedLinkId: trackedLink.id,
          }
        : {}),
    },
    select: { id: true, sessionId: true },
  });

  await prisma.whatsAppMessage
    .create({
      data: {
        workspaceId,
        leadId: lead.id,
        direction: "INBOUND",
        providerMessageId: message.id ?? null,
        body,
      },
    })
    // Same provider id twice means a webhook retry, not a new message.
    .catch(() => undefined);

  const replied = await maybeAutoReply({
    leadId: lead.id,
    workspaceId,
    chatId,
    // Reply from the same number the customer messaged, never another one.
    sessionId: sessionId ?? lead.sessionId ?? undefined,
    automation: trackedLink?.automation ?? null,
  });

  return { status: "recorded", leadId: lead.id, replied };
}

async function maybeAutoReply({
  leadId,
  workspaceId,
  chatId,
  sessionId,
  automation,
}: {
  leadId: string;
  workspaceId: string;
  chatId: string;
  sessionId?: string;
  automation: {
    isActive: boolean;
    dmMessage: string;
    openingDmMessage: string | null;
  } | null;
}): Promise<boolean> {
  if (!automation?.isActive) return false;

  const provider = getWhatsAppProvider();
  if (!provider) return false;

  // One auto-reply per lead, ever. After that a human takes over.
  const alreadyReplied = await prisma.whatsAppMessage.count({
    where: { leadId, direction: "OUTBOUND" },
  });
  if (alreadyReplied > 0) return false;

  const text = renderMessageWithoutLink({
    message: automation.openingDmMessage?.trim() || automation.dmMessage,
    commenterName: null,
  });
  if (!text) return false;

  try {
    const { providerMessageId } = await provider.sendText({
      chatId,
      text,
      sessionId,
    });
    await prisma.whatsAppMessage.create({
      data: {
        workspaceId,
        leadId,
        direction: "OUTBOUND",
        providerMessageId,
        body: text,
      },
    });
    await prisma.whatsAppLead.update({
      where: { id: leadId },
      data: { lastOutboundAt: new Date() },
    });
    return true;
  } catch (error) {
    const reason =
      error instanceof WhatsAppProviderError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unknown error";

    await prisma.whatsAppMessage.create({
      data: {
        workspaceId,
        leadId,
        direction: "OUTBOUND",
        body: text,
        errorMessage: reason,
      },
    });
    await prisma.operationalEvent
      .create({
        data: {
          workspaceId,
          source: "SYSTEM",
          level: "WARNING",
          message: "WhatsApp auto-reply failed",
          payload: { chatId, sessionId: sessionId ?? null, reason },
        },
      })
      .catch(() => undefined);
    return false;
  }
}
