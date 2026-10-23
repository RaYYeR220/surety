export const THEME_KEY = "surety-theme";

/**
 * Inline script for <head>, before first paint: applies the saved theme (light is the default) and marks
 * <html data-reveal> so the landing's scroll reveal may hide blocks (without JS they simply stay visible).
 */
export const themeInitScript = `document.documentElement.setAttribute("data-reveal","");try{var t=localStorage.getItem("${THEME_KEY}");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`;
