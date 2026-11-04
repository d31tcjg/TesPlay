# Media description previews

The title details window initially shows at most 300 Unicode code points, including the trailing ellipsis, and three visible lines on every screen size. Whitespace and punctuation count toward the limit. Descriptions exceeding either bound show a **Read more…** button immediately after the preview. Expanding restores the complete source text and line breaks; **Read less** returns to the preview. Short descriptions that fit remain complete without a toggle.

The disclosure button has a 44px minimum touch target and exposes `aria-expanded` and `aria-controls`. A different description starts collapsed. No provider data or saved description is shortened.

Description behavior is covered by media-details state tests. Check long and short descriptions, Unicode text, keyboard access and narrow phone layouts when changing this component. See [verification](verification.md).
