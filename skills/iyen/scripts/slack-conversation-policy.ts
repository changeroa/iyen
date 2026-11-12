/** Conversation admission is separate from owner execution authority. */
export type ConversationPolicy = {
  owner: string;
  ownerChannels: readonly string[];
  channelOwners?: readonly { channel: string; user: string }[];
  allowGuestConversations?: boolean;
};
export function slackConversationAuthority(
  event: { user: string; channel: string; channel_type?: string; type?: string; text?: string; thread_ts?: string; parent_user_id?: string },
  bot: string, owns: (channel: string, root: string) => boolean, policy: ConversationPolicy,
): "owner" | "guest" | undefined {
  const owner = event.user === policy.owner || policy.channelOwners?.some(o => o.channel === event.channel && o.user === event.user);
  const addressed = event.type === "app_mention" || (event.text ?? "").includes(`<@${bot}>`) ||
    event.channel_type === "im" || Boolean(event.thread_ts && (event.parent_user_id === bot || owns(event.channel, event.thread_ts)));
  if (owner && (addressed || policy.ownerChannels.includes(event.channel) || policy.channelOwners?.some(o => o.channel === event.channel && o.user === event.user))) return "owner";
  if (!owner && policy.allowGuestConversations === true && addressed) return "guest";
  return undefined;
}
