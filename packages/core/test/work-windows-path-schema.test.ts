import { expect, test } from "bun:test"
import { Schema } from "effect"
import { WorkWindowsPathSchema } from "../src/session/work-windows-path.schema"

test("Windows grant paths preserve portable bytes and reject Win32 reinterpretations", () => {
  for (const value of ["input.ts", ".config/input.ts", "目录/输入.ts", "a space/output.txt", "COM10.txt", "PRINTER.txt"])
    expect(Schema.is(WorkWindowsPathSchema.Relative)(value)).toBeTrue()
  for (const value of ["", "/input.ts", "a//b", "a/", "a/./b", "../b", "a/../b", "C:input.ts", "C:/input.ts",
    "a\\b", "input.ts:private", "a/*", "a/?", "a/<b", 'a/"b', "a/|b", "a/\0b", "a/\u001fb", "a/\u007fb",
    "a/b.", "a/b ", "CON", "con.txt", "PRN.tar.gz", "AUX", "NUL.txt", "COM1.log", "LPT9", "COM¹.txt", "LPT²",
    "CLOCK$", "CONIN$", "CONOUT$.txt", ".DAC-HOME/input", ".dac-tmp/output", "a/\ud800", "x".repeat(256),
    Array(17).fill("a").join("/"), Array(9).fill("字".repeat(85)).join("/")])
    expect(Schema.is(WorkWindowsPathSchema.Relative)(value)).toBeFalse()
  expect(Schema.is(WorkWindowsPathSchema.Relative)("x".repeat(255))).toBeTrue()
  expect(Schema.is(WorkWindowsPathSchema.DirectoryRelative)("")).toBeTrue()
  expect(Schema.is(WorkWindowsPathSchema.DirectoryRelative)(".dac-home")).toBeTrue()
  expect(Schema.is(WorkWindowsPathSchema.MemberRelative)(".dac-tmp/owned")).toBeTrue()
})

test("Windows custody absolute paths accept canonical local forms and reject other namespaces", () => {
  const volume = "\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\"
  for (const value of ["C:\\", "C:\\Users\\private\\project", "D:\\目录\\文件", volume, `${volume}private\\project`])
    expect(Schema.is(WorkWindowsPathSchema.Absolute)(value)).toBeTrue()
  for (const value of ["", "c:\\Users\\private", "C:", "C:relative", "\\rooted", "/tmp/a", "C:/Users/private",
    "\\\\server\\share\\a", "\\\\?\\C:\\private", "\\\\.\\PhysicalDrive0", "\\??\\C:\\private",
    "C:\\private\\", "C:\\private\\..\\a", "C:\\private\\.\\a", "C:\\private\\NUL.txt",
    "C:\\private\\a:stream", "C:\\private\\a.", `${volume}a\\\\b`, `${volume}a\\\ud800`,
    `${volume}${Array(33).fill("a").join("\\")}`, `C:\\${Array(9).fill("字".repeat(85)).join("\\")}`])
    expect(Schema.is(WorkWindowsPathSchema.Absolute)(value)).toBeFalse()
})

test("Windows manifest path prechecks reject case aliases and overlapping trees without rewriting names", () => {
  expect(WorkWindowsPathSchema.unique(["src/Input.ts", "src/output.ts"])).toBeTrue()
  expect(WorkWindowsPathSchema.unique(["src/Input.ts", "SRC/input.ts"])).toBeFalse()
  expect(WorkWindowsPathSchema.nonOverlapping(["src", "SRC/input.ts"])).toBeFalse()
  expect(WorkWindowsPathSchema.nonOverlapping(["src/Input.ts", "src/input.ts"])).toBeFalse()
  expect(WorkWindowsPathSchema.nonOverlapping(["src", "src-other/file"])).toBeTrue()
  expect(WorkWindowsPathSchema.nonOverlapping(["目录/输入.ts", "目录/输出.ts"])).toBeTrue()
})
