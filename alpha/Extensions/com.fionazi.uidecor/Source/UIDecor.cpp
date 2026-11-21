// ---------------------------------------------------------------
//  UI Decor - an extension that dresses the Fiona Zi editor
//  Copyright (c) 2026 Nabras. All rights reserved.
// ---------------------------------------------------------------
//
// What it does, all through the SDK's IEditor (no ImGui, no engine headers):
//   * colour themes for the whole editor (Navy Night, Rose, Mint, Mono) and your
//     own four colours;
//   * frames on or off (borders), and rounded corners;
//   * decorations drawn on the editor's windows every frame, the way a profile
//     picture wears an animated frame: a neon frame whose colours run round the
//     focused panel, corner ornaments, sparkles (an animated GIF) twinkling along
//     the edge, sakura petals falling inside it, flames on its top corners (a
//     sprite strip), and a glow with a moving shimmer on menus and popups.
//
// Settings are saved in Project/ExtensionData/com.fionazi.uidecor/uidecor.cfg.
#include "FZEExtensionSDK.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <initializer_list>

using namespace FZE::Extension;

namespace {

    IContext* g_Ctx = nullptr;
    bool g_Running = false;
    ImageHandle g_Flame = 0, g_Sparkle = 0, g_Petal = 0;
    int32_t g_FlameFrames = 1, g_SparkleFrames = 1;
    float g_SparkleSeconds = 0.09f;

    // ---- the settings ----------------------------------------------------------
    enum Theme : int32_t { EditorOwn = 0, NavyNight, Rose, Mint, Mono, Custom };
    struct Settings {
        int32_t Theme = NavyNight;
        float Accent[4] = { 0.32f, 0.56f, 1.00f, 1.0f };
        float Window[4] = { 0.085f, 0.105f, 0.155f, 1.0f };
        float Title[4]  = { 0.055f, 0.085f, 0.165f, 1.0f };
        float Text[4]   = { 0.92f, 0.94f, 0.98f, 1.0f };
        bool  Frames = true;            // window borders
        float Rounding = 6.0f;          // < 0: the editor's own
        bool  Neon = true;
        float NeonColor[4] = { 0.35f, 0.70f, 1.00f, 1.0f };
        bool  Corners = true;
        bool  Sparkles = true;
        bool  Petals = false;
        int32_t PetalCount = 14;
        bool  Flames = false;
        bool  MenuGlow = true;
        bool  FocusedOnly = true;
        float Speed = 1.0f;
    } S;

    const float kPresets[5][4][4] = {
        // accent, window, title, text
        { { 0.32f, 0.56f, 1.00f, 1 }, { 0.085f, 0.105f, 0.155f, 1 }, { 0.055f, 0.085f, 0.165f, 1 }, { 0.92f, 0.94f, 0.98f, 1 } },  // navy night
        { { 0.98f, 0.45f, 0.62f, 1 }, { 0.140f, 0.095f, 0.115f, 1 }, { 0.200f, 0.090f, 0.125f, 1 }, { 0.99f, 0.93f, 0.95f, 1 } },  // rose
        { { 0.30f, 0.86f, 0.66f, 1 }, { 0.075f, 0.120f, 0.110f, 1 }, { 0.060f, 0.150f, 0.125f, 1 }, { 0.92f, 0.99f, 0.96f, 1 } },  // mint
        { { 0.82f, 0.82f, 0.84f, 1 }, { 0.110f, 0.110f, 0.115f, 1 }, { 0.080f, 0.080f, 0.085f, 1 }, { 0.95f, 0.95f, 0.95f, 1 } },  // mono
        { { 0.32f, 0.56f, 1.00f, 1 }, { 0.085f, 0.105f, 0.155f, 1 }, { 0.055f, 0.085f, 0.165f, 1 }, { 0.92f, 0.94f, 0.98f, 1 } },  // (custom starts here)
    };

    // ---- saving --------------------------------------------------------------------
    bool SettingsPath(char* out, size_t cap) {
        char dir[512];
        if (!g_Ctx || g_Ctx->Core()->DataDirectory(dir, sizeof(dir)) == 0) return false;
        std::snprintf(out, cap, "%s/uidecor.cfg", dir);
        return true;
    }
    void Save() {
        char path[600];
        if (!SettingsPath(path, sizeof(path))) return;
        FILE* f = std::fopen(path, "w");
        if (!f) return;
        auto c4 = [&](const char* k, const float* c) { std::fprintf(f, "%s %g %g %g %g\n", k, c[0], c[1], c[2], c[3]); };
        std::fprintf(f, "theme %d\n", S.Theme);
        c4("accent", S.Accent); c4("window", S.Window); c4("title", S.Title); c4("text", S.Text);
        std::fprintf(f, "frames %d\nrounding %g\nneon %d\n", S.Frames, S.Rounding, S.Neon);
        c4("neoncolor", S.NeonColor);
        std::fprintf(f, "corners %d\nsparkles %d\npetals %d\npetalcount %d\nflames %d\nmenuglow %d\nfocusedonly %d\nspeed %g\n",
                     S.Corners, S.Sparkles, S.Petals, S.PetalCount, S.Flames, S.MenuGlow, S.FocusedOnly, S.Speed);
        std::fclose(f);
    }
    void Load() {
        char path[600];
        if (!SettingsPath(path, sizeof(path))) return;
        FILE* f = std::fopen(path, "r");
        if (!f) return;
        char key[32];
        while (std::fscanf(f, "%31s", key) == 1) {
            auto c4 = [&](float* c) { std::fscanf(f, "%f %f %f %f", &c[0], &c[1], &c[2], &c[3]); };
            auto b = [&](bool& v) { int x = 0; std::fscanf(f, "%d", &x); v = x != 0; };
            if (!std::strcmp(key, "theme")) std::fscanf(f, "%d", &S.Theme);
            else if (!std::strcmp(key, "accent")) c4(S.Accent);
            else if (!std::strcmp(key, "window")) c4(S.Window);
            else if (!std::strcmp(key, "title")) c4(S.Title);
            else if (!std::strcmp(key, "text")) c4(S.Text);
            else if (!std::strcmp(key, "frames")) b(S.Frames);
            else if (!std::strcmp(key, "rounding")) std::fscanf(f, "%f", &S.Rounding);
            else if (!std::strcmp(key, "neon")) b(S.Neon);
            else if (!std::strcmp(key, "neoncolor")) c4(S.NeonColor);
            else if (!std::strcmp(key, "corners")) b(S.Corners);
            else if (!std::strcmp(key, "sparkles")) b(S.Sparkles);
            else if (!std::strcmp(key, "petals")) b(S.Petals);
            else if (!std::strcmp(key, "petalcount")) std::fscanf(f, "%d", &S.PetalCount);
            else if (!std::strcmp(key, "flames")) b(S.Flames);
            else if (!std::strcmp(key, "menuglow")) b(S.MenuGlow);
            else if (!std::strcmp(key, "focusedonly")) b(S.FocusedOnly);
            else if (!std::strcmp(key, "speed")) std::fscanf(f, "%f", &S.Speed);
        }
        std::fclose(f);
    }

    // ---- the editor's style --------------------------------------------------------
    void Mix(const float* a, const float* b, float k, float alpha, float out[4]) {
        for (int i = 0; i < 3; ++i) out[i] = a[i] + (b[i] - a[i]) * k;
        out[3] = alpha;
    }
    void ApplyStyle() {
        IEditor* ed = g_Ctx ? g_Ctx->Editor() : nullptr;
        if (!ed) return;
        ed->ResetStyle();
        if (!g_Running) return;
        if (S.Theme != EditorOwn) {
            const float white[4] = { 1, 1, 1, 1 }, black[4] = { 0, 0, 0, 1 };
            float c[4];
            auto set = [&](const char* n, const float* v) { ed->SetStyleColor(n, v); };
            auto acc = [&](const char* n, float a) { float v[4] = { S.Accent[0], S.Accent[1], S.Accent[2], a }; set(n, v); };
            set("WindowBg", S.Window);
            Mix(S.Window, black, 0.25f, 1.0f, c); set("ChildBg", c);
            Mix(S.Window, white, 0.05f, 0.98f, c); set("PopupBg", c);
            set("TitleBg", S.Title); set("MenuBarBg", S.Title);
            Mix(S.Title, S.Accent, 0.25f, 1.0f, c); set("TitleBgActive", c);
            acc("Border", 0.30f);
            Mix(S.Window, black, 0.35f, 1.0f, c); set("FrameBg", c);
            Mix(S.Window, S.Accent, 0.18f, 1.0f, c); set("FrameBgHovered", c);
            Mix(S.Window, S.Accent, 0.30f, 1.0f, c); set("FrameBgActive", c);
            acc("Header", 0.30f); acc("HeaderHovered", 0.45f); acc("HeaderActive", 0.60f);
            acc("Button", 0.26f); acc("ButtonHovered", 0.45f); acc("ButtonActive", 0.65f);
            set("Tab", S.Title); set("TabDimmed", S.Title);
            Mix(S.Title, S.Accent, 0.45f, 1.0f, c); set("TabSelected", c);
            Mix(S.Title, S.Accent, 0.28f, 1.0f, c); set("TabDimmedSelected", c);
            acc("TabHovered", 0.55f); acc("TabSelectedOverline", 1.0f);
            acc("CheckMark", 1.0f); acc("SliderGrab", 0.85f); acc("SliderGrabActive", 1.0f);
            acc("Separator", 0.30f); acc("SeparatorHovered", 0.60f); acc("ResizeGrip", 0.25f); acc("ResizeGripHovered", 0.6f);
            acc("ScrollbarGrab", 0.30f); acc("ScrollbarGrabHovered", 0.5f); acc("DockingPreview", 0.55f);
            acc("TextSelectedBg", 0.35f); acc("PlotHistogram", 0.9f);
            set("Text", S.Text);
            Mix(S.Text, S.Window, 0.45f, 1.0f, c); set("TextDisabled", c);
        }
        if (!S.Frames)
            for (const char* n : { "WindowBorderSize", "ChildBorderSize", "PopupBorderSize", "FrameBorderSize", "TabBorderSize" })
                ed->SetStyleValue(n, 0.0f);
        if (S.Rounding >= 0.0f) {
            for (const char* n : { "WindowRounding", "ChildRounding", "PopupRounding", "TabRounding" }) ed->SetStyleValue(n, S.Rounding);
            ed->SetStyleValue("FrameRounding", S.Rounding < 5.0f ? S.Rounding : 5.0f);
            ed->SetStyleValue("GrabRounding", S.Rounding < 4.0f ? S.Rounding : 4.0f);
        }
    }

    // ---- drawing helpers ------------------------------------------------------------
    float Fract(float x) { return x - std::floor(x); }
    float Hash(float n) { return Fract(std::sin(n * 12.9898f) * 43758.5453f); }
    void Hsv(float h, float s, float v, float out[3]) {
        h = Fract(h) * 6.0f;
        const float c = v * s, x = c * (1.0f - std::fabs(std::fmod(h, 2.0f) - 1.0f)), m = v - c;
        float r = 0, g = 0, b = 0;
        if (h < 1) { r = c; g = x; } else if (h < 2) { r = x; g = c; } else if (h < 3) { g = c; b = x; }
        else if (h < 4) { g = x; b = c; } else if (h < 5) { r = x; b = c; } else { r = c; b = x; }
        out[0] = r + m; out[1] = g + m; out[2] = b + m;
    }
    // A point `s` px along the frame of [x0,y0]-[x1,y1], clockwise from the top left.
    void AlongFrame(float x0, float y0, float x1, float y1, float s, float& x, float& y) {
        const float w = x1 - x0, h = y1 - y0, P = 2.0f * (w + h);
        s = std::fmod(std::fmod(s, P) + P, P);
        if (s < w) { x = x0 + s; y = y0; return; }
        s -= w;
        if (s < h) { x = x1; y = y0 + s; return; }
        s -= h;
        if (s < w) { x = x1 - s; y = y1; return; }
        s -= w;
        x = x0; y = y1 - s;
    }

    // A frame of light whose colours run round the window.
    void NeonFrame(const WindowInfo* w, IPainter* below, IPainter* above, float t) {
        const float x0 = w->X + 1.0f, y0 = w->Y + 1.0f, x1 = w->X + w->Width - 1.0f, y1 = w->Y + w->Height - 1.0f;
        const float P = 2.0f * ((x1 - x0) + (y1 - y0));
        const int n = (int)(P / 7.0f);
        for (int i = 0; i < n; ++i) {
            const float s0 = P * (float)i / (float)n, s1 = P * (float)(i + 1) / (float)n;
            float ax, ay, bx, by;
            AlongFrame(x0, y0, x1, y1, s0, ax, ay);
            AlongFrame(x0, y0, x1, y1, s1, bx, by);
            float rgb[3];
            Hsv(s0 / P - t * 0.12f, 0.55f, 1.0f, rgb);
            float c[3];
            for (int k = 0; k < 3; ++k) c[k] = rgb[k] * 0.45f + S.NeonColor[k] * 0.55f;
            const float pulse = 0.65f + 0.35f * std::sin(t * 2.0f + s0 * 0.02f);
            above->Line(ax, ay, bx, by, Rgba(c[0], c[1], c[2], pulse), 2.0f);
        }
        // the glow it throws round the window
        for (int k = 1; k <= 4; ++k) {
            const float g = (float)k * 2.5f;
            below->Rect(w->X - g, w->Y - g, w->X + w->Width + g, w->Y + w->Height + g,
                        Rgba(S.NeonColor[0], S.NeonColor[1], S.NeonColor[2], 0.16f / (float)k), 6.0f + g, 2.5f);
        }
    }

    // Brackets and a diamond at each corner, breathing.
    void Corners(const WindowInfo* w, IPainter* above, float t) {
        const float L = 14.0f, a = 0.70f + 0.30f * std::sin(t * 1.6f);
        const uint32_t col = Rgba(S.Accent[0], S.Accent[1], S.Accent[2], a);
        const float x0 = w->X + 3.0f, y0 = w->Y + 3.0f, x1 = w->X + w->Width - 3.0f, y1 = w->Y + w->Height - 3.0f;
        const float cx[4] = { x0, x1, x1, x0 }, cy[4] = { y0, y0, y1, y1 }, sx[4] = { 1, -1, -1, 1 }, sy[4] = { 1, 1, -1, -1 };
        for (int i = 0; i < 4; ++i) {
            above->Line(cx[i], cy[i], cx[i] + sx[i] * L, cy[i], col, 2.0f);
            above->Line(cx[i], cy[i], cx[i], cy[i] + sy[i] * L, col, 2.0f);
            const float dx = cx[i] + sx[i] * 6.0f, dy = cy[i] + sy[i] * 6.0f, r = 2.6f + 0.8f * std::sin(t * 3.0f + (float)i);
            const float d[8] = { dx, dy - r, dx + r, dy, dx, dy + r, dx - r, dy };
            above->PolygonFilled(d, 4, Rgba(1.0f, 1.0f, 1.0f, 0.85f));
        }
    }

    // Stars twinkling along the frame: the GIF's own frames, each star out of step.
    void Sparkles(const WindowInfo* w, IPainter* above, float t) {
        const float x0 = w->X, y0 = w->Y, x1 = w->X + w->Width, y1 = w->Y + w->Height;
        const float P = 2.0f * (w->Width + w->Height);
        for (int i = 0; i < 10; ++i) {
            const float h = Hash((float)i + 1.0f);
            float x, y;
            AlongFrame(x0, y0, x1, y1, Fract(h + t * 0.015f) * P, x, y);
            const float twinkle = 0.5f + 0.5f * std::sin(t * (2.0f + 2.0f * h) + h * 40.0f);
            const float size = 10.0f + 12.0f * twinkle;
            if (g_Sparkle) {
                const int frame = (int)(t / g_SparkleSeconds) + i * 3;
                above->Image(g_Sparkle, frame, x - size * 0.5f, y - size * 0.5f, x + size * 0.5f, y + size * 0.5f,
                             Rgba(1.0f, 1.0f, 1.0f, 0.4f + 0.6f * twinkle));
            } else {
                const float r = size * 0.4f, q = r * 0.25f;
                const float star[16] = { x, y - r, x + q, y - q, x + r, y, x + q, y + q, x, y + r, x - q, y + q, x - r, y, x - q, y - q };
                above->Polyline(star, 8, Rgba(1, 1, 1, twinkle), true, 1.5f);
            }
        }
    }

    // Petals drifting down inside the window, turning as they fall.
    void Petals(const WindowInfo* w, IPainter* above, float t) {
        const float top = w->Y + w->TitleHeight, h = w->Height - w->TitleHeight;
        if (h < 30.0f || !g_Petal) return;
        above->PushClip(w->X, top, w->X + w->Width, w->Y + w->Height);
        for (int i = 0; i < S.PetalCount; ++i) {
            const float a = Hash((float)i * 3.1f + 0.7f), b = Hash((float)i * 7.7f + 1.3f), c = Hash((float)i * 1.9f + 4.1f);
            const float fall = Fract(a + t * (0.05f + 0.06f * b));
            const float x = w->X + b * w->Width + std::sin(t * (0.8f + c) + a * 6.28f) * 18.0f;
            const float y = top - 12.0f + fall * (h + 24.0f);
            const float size = 24.0f + 14.0f * c;   // the petal fills about half its picture
            above->ImageRotated(g_Petal, 0, x, y, size, size, t * (1.0f + 2.0f * c) + a * 6.28f, Rgba(1, 1, 1, 0.85f));
        }
        above->PopClip();
    }

    // Flames on the window's two top corners, like a profile picture's animated frame.
    void Flames(const WindowInfo* w, IPainter* above, float t) {
        if (!g_Flame) return;
        const float size = 30.0f;
        const int frame = (int)(t * 12.0f);
        above->Image(g_Flame, frame, w->X - 8.0f, w->Y - size + 8.0f, w->X - 8.0f + size, w->Y + 8.0f, Rgba(1, 1, 1, 0.95f));
        above->Image(g_Flame, frame + 3, w->X + w->Width - size + 8.0f, w->Y - size + 8.0f, w->X + w->Width + 8.0f, w->Y + 8.0f,
                     Rgba(1, 1, 1, 0.95f));
    }

    // Menus and popups: a soft glow round them and a shimmer along their top edge.
    void MenuGlow(const WindowInfo* w, IPainter* below, IPainter* above, float t) {
        for (int k = 1; k <= 3; ++k) {
            const float g = (float)k * 2.0f;
            below->Rect(w->X - g, w->Y - g, w->X + w->Width + g, w->Y + w->Height + g,
                        Rgba(S.Accent[0], S.Accent[1], S.Accent[2], 0.14f / (float)k), 5.0f + g, 2.0f);
        }
        const float span = 70.0f, x = w->X - span + Fract(t * 0.45f) * (w->Width + span);
        above->PushClip(w->X, w->Y, w->X + w->Width, w->Y + 3.0f);
        const uint32_t clear = Rgba(1, 1, 1, 0.0f), bright = Rgba(1, 1, 1, 0.75f);
        above->RectGradient(x, w->Y, x + span * 0.5f, w->Y + 2.0f, clear, bright, bright, clear);
        above->RectGradient(x + span * 0.5f, w->Y, x + span, w->Y + 2.0f, bright, clear, clear, bright);
        above->PopClip();
    }

    void Decorate(void*, const WindowInfo* w, IPainter* below, IPainter* above) {
        if (!g_Running || !w || !w->Kind) return;
        const float t = w->Time * S.Speed;
        const bool menu = !std::strcmp(w->Kind, "menu") || !std::strcmp(w->Kind, "popup");
        if (menu) { if (S.MenuGlow) MenuGlow(w, below, above, t); return; }
        const bool panel = !std::strcmp(w->Kind, "panel") || !std::strcmp(w->Kind, "floating");
        if (!panel || w->Width < 80.0f || w->Height < 60.0f) return;
        if (S.FocusedOnly && !(w->Flags & WindowFocused)) return;
        if (S.Neon) NeonFrame(w, below, above, t);
        if (S.Corners) Corners(w, above, t);
        if (S.Petals) Petals(w, above, t);
        if (S.Sparkles) Sparkles(w, above, t);
        if (S.Flames) Flames(w, above, t);
    }

    // ---- its panel ----------------------------------------------------------------
    void UsePreset(int theme) {
        S.Theme = theme;
        if (theme >= NavyNight && theme <= Mono) {
            const float (*p)[4] = kPresets[theme - NavyNight];
            for (int i = 0; i < 4; ++i) { S.Accent[i] = p[0][i]; S.Window[i] = p[1][i]; S.Title[i] = p[2][i]; S.Text[i] = p[3][i]; }
            for (int i = 0; i < 3; ++i) S.NeonColor[i] = p[0][i];
        }
    }

    void DrawPanel(void*, IUI* ui) {
        bool style = false, any = false;
        ui->Heading("UI Decor");
        ui->TextMuted("Colours, frames and animated decorations for the editor's own windows and menus.");
        if (ui->Section("Colours")) {
            const char* names[] = { "Editor's own", "Navy Night", "Rose", "Mint", "Mono" };
            for (int i = 0; i < 5; ++i) {
                if (i) ui->SameLine();
                char label[48];
                std::snprintf(label, sizeof(label), "%s%s", S.Theme == i ? "* " : "", names[i]);
                if (ui->Button(label)) { UsePreset(i); style = true; }
            }
            if (S.Theme != EditorOwn) {
                bool c = false;
                c |= ui->Color("Accent", S.Accent);
                c |= ui->Color("Windows", S.Window);
                c |= ui->Color("Title bars", S.Title);
                c |= ui->Color("Text", S.Text);
                if (c) { S.Theme = Custom; style = true; }
            }
        }
        if (ui->Section("Frames")) {
            style |= ui->Checkbox("Window frames", &S.Frames);
            bool own = S.Rounding < 0.0f;
            if (ui->Checkbox("The editor's own corners", &own)) { S.Rounding = own ? -1.0f : 6.0f; style = true; }
            if (!own) style |= ui->Float("Rounding", &S.Rounding, 0.0f, 14.0f);
        }
        if (ui->Section("Decorations")) {
            any |= ui->Checkbox("Neon frame", &S.Neon);
            if (S.Neon) any |= ui->Color("Neon colour", S.NeonColor);
            any |= ui->Checkbox("Corner ornaments", &S.Corners);
            any |= ui->Checkbox("Sparkles (animated GIF)", &S.Sparkles);
            any |= ui->Checkbox("Falling petals", &S.Petals);
            if (S.Petals) any |= ui->Int("Petals", &S.PetalCount, 1, 40);
            any |= ui->Checkbox("Flame corners (sprite strip)", &S.Flames);
            any |= ui->Checkbox("Glow on menus and popups", &S.MenuGlow);
            any |= ui->Checkbox("Only the panel in use", &S.FocusedOnly);
            any |= ui->Float("Speed", &S.Speed, 0.1f, 3.0f);
        }
        ui->Spacing();
        if (ui->Button("Put everything back")) { S = Settings{}; S.Theme = EditorOwn; S.Rounding = -1.0f; S.Neon = S.Corners = S.Sparkles = S.MenuGlow = false; style = true; }
        if (style) ApplyStyle();
        if (style || any) Save();
    }

}

class UIDecorEditor final : public FZEExtension {
public:
    bool OnLoad(IContext& ctx) override {
        g_Ctx = &ctx;
        IEditor* ed = ctx.Editor();
        if (!ed) {
            ctx.Logging()->Write(LogLevel::Error, "UI Decor dresses the editor, and this is not the editor");
            return false;
        }
        Load();
        g_Flame = ed->LoadImage("Resources/flame.png", 8);
        g_Sparkle = ed->LoadImage("Resources/sparkle.gif", 1);
        g_Petal = ed->LoadImage("Resources/petal.png", 1);
        float secs = 0.0f;
        if (ed->ImageInfo(g_Sparkle, nullptr, nullptr, &g_SparkleFrames, &secs) && secs > 0.0f) g_SparkleSeconds = secs;
        ed->ImageInfo(g_Flame, nullptr, nullptr, &g_FlameFrames, nullptr);
        ed->RegisterPanel("main", "UI Decor", &DrawPanel, nullptr);
        ed->RegisterDecorator("windows", &Decorate, nullptr);
        ctx.Logging()->Write(LogLevel::Info, "UI Decor ready - View > Extensions > UI Decor");
        return true;
    }
    void OnStart(IContext&) override { g_Running = true; ApplyStyle(); }
    void OnStop(IContext&) override { g_Running = false; ApplyStyle(); }
    void OnUnload(IContext&) override { g_Running = false; g_Ctx = nullptr; }
};

FZE_DECLARE_EXTENSION(UIDecorEditor)
