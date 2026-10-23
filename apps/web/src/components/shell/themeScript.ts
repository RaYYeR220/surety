export const THEME_KEY = "surety-theme";

/** Inline script for <head>: applies the saved theme before first paint (light is the default). */
export const themeInitScript = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`;
