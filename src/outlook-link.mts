// Links into Outlook for an email. Graph's webLink (owa/?ItemID=…&viewmodel=ReadMessageItem) no
// longer opens: the new Outlook for Windows, and Outlook on the web, answer it with
// ERR_INVALID_RESPONSE. The deep link to read a message by its id does open, in the new Outlook
// app when Windows hands it Outlook links, else in the browser.

const OUTLOOK_LINK = /^https:\/\/outlook\.(office365|office|live)\.com\/(owa|mail)\//;
const LEGACY_ITEM = /^https:\/\/outlook\.(?:office365|office|live)\.com\/owa\/\?(?:[^#]*&)?ItemID=([^&#]+)/i;

/** A link into Outlook (on the web, or the new Outlook app). */
export const isOutlookLink = (url: unknown): url is string => typeof url === "string" && url.length < 2000 && OUTLOOK_LINK.test(url);

/** A message in Outlook, by its Graph id. */
export function outlookMessageLink(id: string): string {
    const e = encodeURIComponent(id);
    return `https://outlook.office.com/mail/deeplink/read/${e}?ItemID=${e}&exvsurl=1`;
}

/** A link to an email that opens: an old owa/?ItemID= link becomes the deep link; another Outlook link is kept; anything else is "". */
export function openableOutlookLink(link: unknown): string {
    if (!isOutlookLink(link)) return "";
    const legacy = LEGACY_ITEM.exec(link);
    if (!legacy) return link;
    try {
        const id = decodeURIComponent(legacy[1]);
        return id ? outlookMessageLink(id) : "";
    } catch {
        return "";
    }
}
