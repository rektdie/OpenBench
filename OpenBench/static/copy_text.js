
function copy_text(element_id, keep_url, discord_format = false) {
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
        document.execCommand("copy");
        document.body.removeChild(area);
    }
    catch (err) {
        document.body.removeChild(area);
        console.error("Unable to copy to Clipboard");
    }
}