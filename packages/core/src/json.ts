// iLink ids are int64. JSON.parse would round values above 2^53 (real
// message ids are ~7.5e18), so quote them before parsing.
const BIG_INT_FIELDS = /"(message_id|seq|msg_id)"(\s*):(\s*)(-?\d+)/g;

export function parseIlinkJson<T>(text: string): T {
  return JSON.parse(text.replace(BIG_INT_FIELDS, '"$1"$2:$3"$4"')) as T;
}
