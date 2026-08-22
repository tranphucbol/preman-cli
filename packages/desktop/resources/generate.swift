#!/usr/bin/env swift
//
// Reshapes `icon.source.png` into `icon.png`, the app icon.
//
// macOS masks nothing: the dock draws the bitmap it is handed, alpha and all. An opaque square
// PNG therefore renders as an opaque square, which is why this step exists at all. Native icons
// look rounded because the artwork is rounded, on Apple's macOS icon grid — a 1024 canvas with
// the body inset to 824 and continuous-curvature corners. The inset is not decoration: it is the
// margin every other icon in the dock has, and without it this one is drawn visibly larger.
//
// Run from this directory: `swift generate.swift`
//
import AppKit

let canvas = 1024.0
let body = 824.0
let radius = 185.4
let sourceName = "icon.source.png"
let outputName = "icon.png"

let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()

guard let source = NSImage(contentsOf: directory.appendingPathComponent(sourceName)),
      let sourceRef = source.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
    FileHandle.standardError.write(Data("generate: cannot read \(sourceName)\n".utf8))
    exit(1)
}

// `.continuous` is the squircle: CoreGraphics' own rounded rect is circular arcs, which reads as
// a visibly different, tighter corner beside a native icon. CALayer is the only place AppKit
// exposes the continuous curve, so the shape is drawn by rendering a one-layer tree.
let tile = CALayer()
tile.frame = CGRect(x: 0, y: 0, width: body, height: body)
tile.cornerRadius = radius
tile.cornerCurve = .continuous
tile.masksToBounds = true
tile.contentsGravity = .resizeAspectFill
tile.contents = sourceRef

guard let context = CGContext(
    data: nil,
    width: Int(canvas),
    height: Int(canvas),
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    FileHandle.standardError.write(Data("generate: cannot allocate the canvas\n".utf8))
    exit(1)
}

// `render(in:)` draws the root layer at the context origin and ignores its frame, so the inset
// has to come from the context rather than from `tile.frame`.
let inset = (canvas - body) / 2
context.translateBy(x: inset, y: inset)
tile.render(in: context)

guard let rendered = context.makeImage() else {
    FileHandle.standardError.write(Data("generate: cannot rasterise the canvas\n".utf8))
    exit(1)
}

let representation = NSBitmapImageRep(cgImage: rendered)
representation.size = NSSize(width: canvas, height: canvas)

guard let png = representation.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write(Data("generate: cannot encode the png\n".utf8))
    exit(1)
}

try png.write(to: directory.appendingPathComponent(outputName))
FileHandle.standardOutput.write(Data("generate: wrote \(outputName)\n".utf8))
