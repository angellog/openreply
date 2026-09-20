/**
 * The Meta app walkthrough.
 *
 * Meta's console asks for a handful of URLs and a token, and every one of them
 * has to match this instance exactly. Retyping them is where people lose the
 * afternoon the setup guide warns about, so the console derives each value from
 * the live configuration and hands it over as something to copy, never to type.
 *
 * The steps mirror docs/setup.md; the notes are the specific wrong turns that
 * guide documents, kept next to the field they apply to.
 */

export interface MetaWizardValue {
  label: string;
  value: string;
  /** Where this exact string goes in Meta's console. */
  destination: string;
  note?: string;
}

export interface MetaWizardStep {
  id: string;
  title: string;
  where: string;
  instructions: string[];
  values?: MetaWizardValue[];
  warning?: string;
}

export interface MetaWizard {
  baseUrl: string;
  isLocal: boolean;
  steps: MetaWizardStep[];
}

export function buildMetaWizard({
  baseUrl,
  verifyToken,
}: {
  baseUrl: string;
  verifyToken: string;
}): MetaWizard {
  const origin = normalizeOrigin(baseUrl);
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(origin);
  const redirectUri = `${origin}/api/instagram/callback`;
  const webhookUrl = `${origin}/api/webhook`;
  const deauthorizeUrl = `${origin}/api/instagram/disconnect`;
  const deletionUrl = `${origin}/data-deletion`;

  return {
    baseUrl: origin,
    isLocal,
    steps: [
      {
        id: "create-app",
        title: "Create the Meta app",
        where: "developers.facebook.com/apps",
        instructions: [
          "Create a new app. When Meta asks what you are building, choose the use case that offers Instagram.",
          "You need a Facebook account for this — there is no Instagram-only path to the developer console.",
          "The Instagram account you eventually connect must be a Business or Creator account. Switch it in the Instagram app under Settings → Account type.",
        ],
      },
      {
        id: "instagram-login",
        title: "Add Instagram with Instagram Login",
        where: "Your app → Instagram → API setup with Instagram login",
        instructions: [
          "Open the Instagram product and pick the API setup with Instagram login flow, not the Facebook Login one.",
          "Copy the Instagram app ID and Instagram app secret from this panel into the Environment tab.",
        ],
        warning:
          "The ID at the top of the app dashboard is the Facebook app ID. It is a different number and it will not work here.",
      },
      {
        id: "oauth-redirect",
        title: "Register the OAuth redirect",
        where: "Instagram → API setup with Instagram login → Business login settings",
        instructions: [
          "Paste this into OAuth redirect URIs. It has to match character for character, including the scheme and any trailing path.",
        ],
        values: [
          {
            label: "OAuth redirect URI",
            value: redirectUri,
            destination: "Business login settings → OAuth redirect URIs",
          },
          {
            label: "Deauthorize callback URL",
            value: deauthorizeUrl,
            destination: "Business login settings → Deauthorize callback URL",
          },
          {
            label: "Data deletion request URL",
            value: deletionUrl,
            destination: "Business login settings → Data deletion request URL",
          },
        ],
      },
      {
        id: "app-secret",
        title: "Copy the Facebook app secret",
        where: "Your app → App settings → Basic",
        instructions: [
          "Reveal the App secret here and put it in FACEBOOK_APP_SECRET on the Environment tab.",
          "This is the key that signs incoming webhooks. It is a different value from the Instagram app secret in step 2.",
        ],
        warning:
          "Using the Instagram app secret here makes every webhook fail signature verification, which shows up as a 401 and a warning in Diagnostics rather than an obvious error.",
      },
      {
        id: "webhook",
        title: "Point the webhook at this instance",
        where: "Your app → Instagram → Webhooks (or Webhooks → Instagram)",
        instructions: [
          "Paste the callback URL and the verify token, then press Verify and save. Meta calls the URL once and expects the challenge echoed back.",
          "Run the Webhook handshake check on the Overview tab first — it performs the identical request locally, so a failure there means Meta will fail too.",
          "After it saves, subscribe to the comments field. Without that subscription nothing is ever delivered.",
        ],
        values: [
          {
            label: "Callback URL",
            value: webhookUrl,
            destination: "Webhooks → Callback URL",
          },
          {
            label: "Verify token",
            value: verifyToken || "(generate one on the Environment tab)",
            destination: "Webhooks → Verify token",
            note: "Must equal WEBHOOK_VERIFY_TOKEN in the running process, not just the value on disk. Restart the server after changing it.",
          },
        ],
        warning: isLocal
          ? "This instance is on localhost, which Meta cannot reach. Start a tunnel, set NEXTAUTH_URL to the tunnel URL, restart, and these values will update to match."
          : undefined,
      },
      {
        id: "permissions",
        title: "Request the permissions",
        where: "Your app → App review → Permissions and features",
        instructions: [
          "The connect flow asks for instagram_business_basic, instagram_business_manage_messages, instagram_business_manage_comments, and instagram_business_manage_insights.",
          "In development mode these work for accounts with a role on the app, which is enough to test your own account end to end.",
          "Going live for accounts you do not own means submitting for App Review. META_APP_REVIEW.md in this repo has the submission notes.",
        ],
      },
      {
        id: "connect",
        title: "Connect the account",
        where: "The Targets tab in this console",
        instructions: [
          "With the credentials saved and the server restarted, connect your Instagram account from the Targets tab.",
          "OpenReply stores the returned token encrypted with ENCRYPTION_KEY and subscribes the account to comment events.",
          "Then add a target: pick the post, set the keywords, write the DM.",
        ],
      },
    ],
  };
}

function normalizeOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}
