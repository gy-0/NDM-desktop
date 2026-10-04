/* Window inventory and task-scoped button control in a private research bottle. */
#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

static DWORD original_pid;
static const wchar_t *task_url;
static HWND task_window;
static int matches;
static BOOL CALLBACK find_original(HWND window, LPARAM unused) {
    wchar_t name[256] = {0};
    GetClassNameW(window, name, 256);
    if (wcscmp(name, L"Neat Download Manager 1.4") == 0)
        GetWindowThreadProcessId(window, &original_pid);
    return TRUE;
}

static BOOL CALLBACK child(HWND window, LPARAM parent) {
    wchar_t name[256] = {0}, text[512] = {0};
    GetClassNameW(window, name, 256);
    GetWindowTextW(window, text, 512);
    wprintf(L"child parent=%p hwnd=%p id=%d enabled=%d class=%ls text=%ls\n",
            (void *)parent, window, GetDlgCtrlID(window), IsWindowEnabled(window), name, text);
    return TRUE;
}

static BOOL CALLBACK top(HWND window, LPARAM unused) {
    wchar_t name[256] = {0}, text[512] = {0};
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    if (pid != original_pid) return TRUE;
    GetClassNameW(window, name, 256);
    if (task_url) {
        if (wcscmp(name, L"NeatDownloadWindow") == 0) {
            GetDlgItemTextW(window, 1020, text, 512);
            if (wcscmp(text, task_url) == 0) { task_window = window; matches++; }
        }
        return TRUE;
    }
    GetWindowTextW(window, text, 512);
    wprintf(L"top hwnd=%p class=%ls text=%ls\n", window, name, text);
    EnumChildWindows(window, child, (LPARAM)window);
    return TRUE;
}

int wmain(int argc, wchar_t **argv) {
    EnumWindows(find_original, 0);
    if (!original_pid) return 2;
    if (argc == 3 && (wcscmp(argv[1], L"pause") == 0 || wcscmp(argv[1], L"resume") == 0))
        task_url = argv[2];
    else if (argc != 1) return 3;
    EnumWindows(top, 0);
    if (task_url) {
        if (matches != 1) return 4;
        HWND button = GetDlgItem(task_window, 1051);
        wchar_t text[64] = {0};
        GetWindowTextW(button, text, 64);
        const wchar_t *expected = wcscmp(argv[1], L"pause") == 0 ? L"Pause" : L"Resume";
        if (!IsWindowEnabled(button) || wcscmp(text, expected) != 0) return 5;
        DWORD_PTR result = 0;
        if (!SendMessageTimeoutW(button, BM_CLICK, 0, 0, SMTO_ABORTIFHUNG, 3000, &result)) return 6;
        wprintf(L"accepted action=%ls task=%ls\n", argv[1], task_url);
    }
    return 0;
}
