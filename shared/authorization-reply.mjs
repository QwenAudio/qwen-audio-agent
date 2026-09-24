// A model-selected `accept` is not authorization. Compare the customer's
// actual reply with the preview, while allowing natural, detailed affirmations.
export function isApprovalForPreview(value, preview) {
  const text = String(value || '').trim().toLowerCase()
    .replace(/[.!?。！？,，、]/gu, ' ').trim()
    .replace(/\s+/gu, ' ')
  if (!text) return false
  if (/^(?:(?:yes|yeah|yep|yup|sure|ok|okay)(?: (?:i )?(?:approve|agree|consent|confirm))?|approved?|confirmed?|i (?:approve|agree|consent|confirm)|please (?:proceed|go ahead)|(?:please )?go ahead|(?:please )?proceed|sounds good|that(?:'s| is) (?:fine|correct|right)|同意|批准|确认|确认执行|可以|好的|好|没问题|就这样|按这个办)$/u.test(text)) return true
  if (!/^(?:yes|yeah|yep|yup|sure|ok|okay|approved?|confirmed?|i (?:approve|agree|consent|confirm)|please (?:proceed|go ahead)|(?:please )?go ahead|(?:please )?proceed|同意|确认|可以|好的|没问题)(?:\b|\s)/u.test(text)) return false
  if (/\b(?:but|instead|rather than|actually|wait|stop|different|except|however|also|additionally|switch|changed my mind)\b|改成|换成|不要|不是|等等|但是|另外|还要/u.test(text)) return false
  const proposed = String(preview || '').toLowerCase()
  const references = text.match(/#[a-z0-9]+|\b(?:gift_card|credit_card|paypal|item_id)[_:#-]?[a-z0-9]+\b|\b\d{8,12}\b/gu) || []
  return references.every(reference => proposed.includes(reference))
}
