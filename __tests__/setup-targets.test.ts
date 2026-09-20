import { describe, expect, it } from "vitest";
import {
  TRIGGER_LABELS,
  extractPostIdFromUrl,
  fieldsToTrigger,
  targetInputSchema,
  triggerToFields,
  type TargetTrigger,
} from "@/lib/setup/targets";

const VALID = {
  name: "Launch reel",
  instagramAccountId: "acc_1",
  trigger: "specific_post" as const,
  postId: "17912345678901234",
  keywords: ["LINK"],
  dmMessage: "Here you go {username}",
};

describe("targetInputSchema", () => {
  it("accepts a well-formed target", () => {
    const parsed = targetInputSchema.safeParse(VALID);
    expect(parsed.success).toBe(true);
  });

  it("applies the documented defaults", () => {
    const parsed = targetInputSchema.parse(VALID);
    expect(parsed.wholeWordMatch).toBe(true);
    expect(parsed.matchAnyWord).toBe(false);
    expect(parsed.isActive).toBe(true);
    expect(parsed.publicReplyEnabled).toBe(false);
  });

  it("requires a post when the trigger is a specific post", () => {
    const parsed = targetInputSchema.safeParse({ ...VALID, postId: undefined });
    expect(parsed.success).toBe(false);
  });

  it("does not require a post for any-post or next-reel", () => {
    for (const trigger of ["any_post", "next_reel"] as const) {
      const parsed = targetInputSchema.safeParse({
        ...VALID,
        trigger,
        postId: undefined,
      });
      expect(parsed.success, trigger).toBe(true);
    }
  });

  it("requires keywords unless matching any word", () => {
    expect(targetInputSchema.safeParse({ ...VALID, keywords: [] }).success).toBe(false);
    expect(
      targetInputSchema.safeParse({ ...VALID, keywords: [], matchAnyWord: true }).success
    ).toBe(true);
  });

  it("caps keywords at ten", () => {
    const keywords = Array.from({ length: 11 }, (_, index) => `k${index}`);
    expect(targetInputSchema.safeParse({ ...VALID, keywords }).success).toBe(false);
  });

  it("requires a message when a public reply is enabled", () => {
    expect(
      targetInputSchema.safeParse({
        ...VALID,
        publicReplyEnabled: true,
        publicReplyMessages: [],
      }).success
    ).toBe(false);

    expect(
      targetInputSchema.safeParse({
        ...VALID,
        publicReplyEnabled: true,
        publicReplyMessages: ["Sent!"],
      }).success
    ).toBe(true);
  });

  it("rejects a blank-only public reply", () => {
    expect(
      targetInputSchema.safeParse({
        ...VALID,
        publicReplyEnabled: true,
        publicReplyMessages: ["   "],
      }).success
    ).toBe(false);
  });

  it("rejects an empty DM message", () => {
    expect(targetInputSchema.safeParse({ ...VALID, dmMessage: "   " }).success).toBe(
      false
    );
  });

  it("accepts an empty string for the tracked link, meaning none", () => {
    expect(
      targetInputSchema.safeParse({ ...VALID, trackedDestinationUrl: "" }).success
    ).toBe(true);
    expect(
      targetInputSchema.safeParse({
        ...VALID,
        trackedDestinationUrl: "not-a-url",
      }).success
    ).toBe(false);
  });
});

describe("trigger mapping", () => {
  it("sets exactly one trigger flag, whichever trigger is chosen", () => {
    const triggers: TargetTrigger[] = ["specific_post", "any_post", "next_reel"];
    for (const trigger of triggers) {
      const fields = triggerToFields(trigger, "post_1", "https://instagram.com/p/x");
      const flagsSet = [
        fields.matchAnyPost,
        fields.pendingNextReel,
        fields.postId !== null,
      ].filter(Boolean).length;
      expect(flagsSet, trigger).toBe(1);
    }
  });

  it("clears the post for non-specific triggers, so the worker cannot disagree with the UI", () => {
    const anyPost = triggerToFields("any_post", "post_1", "https://x.test");
    expect(anyPost.postId).toBeNull();
    expect(anyPost.postUrl).toBeNull();

    const nextReel = triggerToFields("next_reel", "post_1", "https://x.test");
    expect(nextReel.postId).toBeNull();
  });

  it("normalizes an empty post URL to null", () => {
    expect(triggerToFields("specific_post", "post_1", "").postUrl).toBeNull();
  });

  it("round-trips through fieldsToTrigger", () => {
    const triggers: TargetTrigger[] = ["specific_post", "any_post", "next_reel"];
    for (const trigger of triggers) {
      const fields = triggerToFields(trigger, "post_1");
      expect(fieldsToTrigger(fields), trigger).toBe(trigger);
    }
  });

  it("labels every trigger", () => {
    for (const trigger of ["specific_post", "any_post", "next_reel"] as const) {
      expect(TRIGGER_LABELS[trigger]).toBeTruthy();
    }
  });
});

describe("extractPostIdFromUrl", () => {
  it("passes a bare media ID straight through", () => {
    expect(extractPostIdFromUrl("17912345678901234")).toBe("17912345678901234");
  });

  it("pulls the shortcode out of a post permalink", () => {
    expect(extractPostIdFromUrl("https://www.instagram.com/p/ABC-123_x/")).toBe(
      "ABC-123_x"
    );
  });

  it("handles reel and tv permalinks", () => {
    expect(extractPostIdFromUrl("https://instagram.com/reel/XyZ9/")).toBe("XyZ9");
    expect(extractPostIdFromUrl("https://instagram.com/tv/XyZ9")).toBe("XyZ9");
  });

  it("returns null for anything else", () => {
    expect(extractPostIdFromUrl("")).toBeNull();
    expect(extractPostIdFromUrl("https://example.com/p/abc")).toBeNull();
    expect(extractPostIdFromUrl("123")).toBeNull();
  });
});
