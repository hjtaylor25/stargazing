/* ============================================================================
   ASTROMAP — Theme Management
   
   Handles switching between three themes:
   - Light: Bright, clean, daytime use
   - Dark: Default, colorful accents on near-black
   - Astronomer: Deep red on true black, protects night vision
   
   Theme choice is persisted to localStorage so it survives page reloads.
   The theme is applied via a data-theme attribute on the html element,
   which CSS rules check using attribute selectors.
   ============================================================================ */

const STORAGE_KEY = 'astromap-theme';
const THEMES = ['light', 'dark', 'astronomer'];
const DEFAULT_THEME = 'dark';

// Initialize theme when DOM is ready
document.addEventListener('DOMContentLoaded', initializeTheme);

/* ============================================================================
   Load and apply the saved theme on page load
   ============================================================================ */

function initializeTheme() {
    // Try to load the user's saved theme from localStorage
    // If nothing is saved, use the default theme
    const savedTheme = localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME;
    
    // Validate that the theme is one of our known themes
    // (protects against corrupted localStorage)
    const validTheme = THEMES.includes(savedTheme) ? savedTheme : DEFAULT_THEME;
    
    // Apply the theme to the page
    applyTheme(validTheme);
    
    // Update the theme button styling
    updateThemeButtonStyling();
    
    // Listen for theme button clicks
    const themeButtons = document.querySelectorAll('.theme-btn');
    themeButtons.forEach(btn => {
        btn.addEventListener('click', function() {
            const theme = this.getAttribute('data-theme');
            applyTheme(theme);
            updateThemeButtonStyling();
        });
    });
}

/* ============================================================================
   Apply a theme to the page
   
   This sets the data-theme attribute on the html element, which causes
   CSS rules in themes.css to apply the appropriate custom property values.
   It also updates the map styling if the map is already loaded.
   ============================================================================ */

function applyTheme(theme) {
    // Validate the theme
    if (!THEMES.includes(theme)) {
        console.warn(`Unknown theme: ${theme}. Using default: ${DEFAULT_THEME}`);
        theme = DEFAULT_THEME;
    }
    
    // Apply to html element (CSS will react to this)
    document.documentElement.setAttribute('data-theme', theme);
    
    // Save to localStorage for next visit
    localStorage.setItem(STORAGE_KEY, theme);

    // Keep the phone's browser chrome in step with the page. Without this the
    // bar above the app stays the dark theme's navy even in Astronomer mode,
    // which is a bright blue strip at the top of a screen whose whole purpose
    // is to have no blue on it.
    updateBrowserThemeColour(theme);
    
    // Nothing else to do. Every themed colour in this app — the panels, the
    // map canvas, even MapLibre's own buttons — is driven from CSS by that one
    // data-theme attribute. There is no second place to keep in sync.
    console.log(`✓ Theme switched to: ${theme}`);
}

/* ----------------------------------------------------------------------------
   The browser's own chrome

   <meta name="theme-color"> tells a mobile browser what colour to paint the
   bar above the page. It cannot read our CSS variables, so the values are
   repeated here — keep them matching --color-bg in css/themes.css.
   -------------------------------------------------------------------------- */

const THEME_COLOURS = {
    light: '#F6F8FC',
    dark: '#0B1020',
    astronomer: '#000000'
};

function updateBrowserThemeColour(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && THEME_COLOURS[theme]) {
        meta.setAttribute('content', THEME_COLOURS[theme]);
    }
}

/* ============================================================================
   Update the theme buttons to show which theme is active
   
   Highlight the active theme button with different styling.
   ============================================================================ */

function updateThemeButtonStyling() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
    const themeButtons = document.querySelectorAll('.theme-btn');
    
    themeButtons.forEach(btn => {
        if (btn.getAttribute('data-theme') === currentTheme) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

/* ============================================================================
   Helper: Get the current active theme
   
   Used by other scripts to know which theme is active (e.g., for styling
   data overlays or maps to match the theme).
   ============================================================================ */

function getCurrentTheme() {
    return document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
}
