/* Window inventory and task-scoped button control in a private research bottle. */
#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#include <windows.h>
#include <commctrl.h>
#include <stdio.h>
#include <wchar.h>

static DWORD original_pid;
static HWND main_window;
static const wchar_t *task_url;
static HWND task_window;
static int matches;
static BOOL CALLBACK find_original(HWND window, LPARAM unused) {
    wchar_t name[256] = {0};
    GetClassNameW(window, name, 256);
    if (wcscmp(name, L"Neat Download Manager 1.4") == 0) {
        main_window = window;
        GetWindowThreadProcessId(window, &original_pid);
    }
    return TRUE;
}

/* Standard controls require caller-owned buffers in the target process for
 * messages above WM_USER. Never pass this helper's local pointers to them. */
static int restore_one(const wchar_t *filename) {
    HWND list = GetDlgItem(main_window, 1018), toolbar = GetDlgItem(main_window, 1017);
    if (!list || !toolbar || SendMessageW(list, LVM_GETITEMCOUNT, 0, 0) != 1) return 10;
    HANDLE process = OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE, FALSE, original_pid);
    if (!process) return 11;
    char *remote = VirtualAllocEx(process, NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    int status = 12, command = 0;
    if (!remote) goto cleanup;
    LVITEMW item = {0};
    wchar_t text[512] = {0};
    item.pszText = (LPWSTR)(remote + 512); item.cchTextMax = 512;
    if (!WriteProcessMemory(process, remote, &item, sizeof(item), NULL)) goto cleanup;
    SendMessageW(list, LVM_GETITEMTEXTW, 0, (LPARAM)remote);
    if (!ReadProcessMemory(process, remote + 512, text, sizeof(text), NULL)) goto cleanup;
    wprintf(L"restore candidate=%ls\n", text);
    if (wcscmp(text, filename) != 0) { status = 13; goto cleanup; }
    int count = (int)SendMessageW(toolbar, TB_BUTTONCOUNT, 0, 0);
    if (count < 1 || count > 64) goto cleanup;
    for (int index = 0; index < count; index++) {
        TBBUTTON button = {0};
        if (!SendMessageW(toolbar, TB_GETBUTTON, index, (LPARAM)remote)) goto cleanup;
        if (!ReadProcessMemory(process, remote, &button, sizeof(button), NULL)) goto cleanup;
        if (button.fsStyle & BTNS_SEP) continue;
        LRESULT length = SendMessageW(toolbar, TB_GETBUTTONTEXTW, button.idCommand, 0);
        if (length < 0 || length >= 512) continue;
        if (SendMessageW(toolbar, TB_GETBUTTONTEXTW, button.idCommand, (LPARAM)(remote + 512)) < 0) continue;
        if (!ReadProcessMemory(process, remote + 512, text, sizeof(text), NULL)) goto cleanup;
        if (wcscmp(text, L"Resume") == 0) { if (command) goto cleanup; command = button.idCommand; }
    }
    if (!command) { status = 14; goto cleanup; }
    ZeroMemory(&item, sizeof(item));
    item.stateMask = LVIS_SELECTED | LVIS_FOCUSED; item.state = item.stateMask;
    if (!WriteProcessMemory(process, remote, &item, sizeof(item), NULL)) goto cleanup;
    if (!SendMessageW(list, LVM_SETITEMSTATE, 0, (LPARAM)remote)) goto cleanup;
    if (!SendMessageW(toolbar, TB_ISBUTTONENABLED, command, 0)) { status = 15; goto cleanup; }
    DWORD_PTR result;
    if (!SendMessageTimeoutW(main_window, WM_COMMAND, MAKEWPARAM(command, 0), 0, SMTO_ABORTIFHUNG, 3000, &result)) goto cleanup;
    wprintf(L"accepted restore filename=%ls command=%d\n", filename, command);
    status = 0;
cleanup:
    if (remote) VirtualFreeEx(process, remote, 0, MEM_RELEASE);
    CloseHandle(process);
    return status;
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
    if (argc == 3 && wcscmp(argv[1], L"restore") == 0) return restore_one(argv[2]);
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
