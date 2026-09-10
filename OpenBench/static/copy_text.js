
// Copies the text content of `element_id` to the clipboard and gives the
// triggering button (`btn`, when passed) brief visual feedback: label
// swaps to "Copied!" with the same green used for passing tests
// elsewhere in the theme, or "Copy failed" in red if the browser
// blocked the copy -- either way the button reverts to its original
// label/state after a couple of seconds.
function copy_text(element_id, keep_url, discord_format = false, btn = null) {
    var text = document.getElementById(element_id).innerHTML;
    text = text.replace(/<br>/g, "\n");

    if (keep_url) {
        if (discord_format) {
            // Wrap stat block in code block, then add URL outside
            text = "```\n" + text + "\n```\n" + window.location.href;
        } else {
            text += "\n" + window.location.href;
        }
    }

    function showFeedback(ok) {
        if (!btn) return;
        if (btn._copyFeedbackTimer) clearTimeout(btn._copyFeedbackTimer);
        if (btn._originalLabel === undefined) btn._originalLabel = btn.innerHTML;

        btn.classList.remove("btn-copied", "btn-copy-error");
        btn.classList.add(ok ? "btn-copied" : "btn-copy-error");
        btn.innerHTML = ok
            ? '<i class="fa-solid fa-check"></i> Copied!'
            : '<i class="fa-solid fa-xmark"></i> Copy failed';

        btn._copyFeedbackTimer = setTimeout(function () {
            btn.classList.remove("btn-copied", "btn-copy-error");
            btn.innerHTML = btn._originalLabel;
            btn._copyFeedbackTimer = null;
        }, 1800);
    }

    // Prefer the modern async Clipboard API when available/permitted;
    // fall back to the old execCommand hack (needed for non-HTTPS/older
    // browsers), and only then report failure.
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () {
            showFeedback(true);
        }).catch(function () {
            legacyCopy();
        });
        return;
    }

    legacyCopy();

    function legacyCopy() {
        var area = document.createElement("textarea");
        area.value = text;
        area.style.position = 'fixed';
        area.style.top = '0';
        area.style.left = '0';
        area.style.width = '1px';
        area.style.height = '1px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.focus();
        area.select();

        try {
            var ok = document.execCommand("copy");
            document.body.removeChild(area);
            showFeedback(!!ok);
        }
        catch (err) {
            document.body.removeChild(area);
            console.error("Unable to copy to Clipboard");
            showFeedback(false);
        }
    }
}
