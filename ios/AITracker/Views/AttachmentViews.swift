import AVKit
import SwiftUI
import WebKit

/// Images of the tracker need the authorization header, so AsyncImage cannot load them.
@MainActor
enum ImageCache {
    static let shared = NSCache<NSString, UIImage>()

    static func load(_ path: String, with client: APIClient?) async -> UIImage? {
        if let cached = shared.object(forKey: path as NSString) { return cached }
        guard let client, let url = URL(string: path, relativeTo: client.baseURL) else { return nil }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(client.key)", forHTTPHeaderField: "Authorization")
        // The URL cache keeps logos and pictures readable without a connection.
        request.cachePolicy = .returnCacheDataElseLoad
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let image = UIImage(data: data) else { return nil }
        shared.setObject(image, forKey: path as NSString)
        return image
    }
}

/// A picture served by the tracker: a project logo or an image attachment.
struct RemoteImage<Placeholder: View>: View {
    @Environment(AppState.self) private var state
    let path: String?
    var contentMode = ContentMode.fill
    @ViewBuilder var placeholder: () -> Placeholder
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                placeholder()
            }
        }
        .task(id: path) {
            guard let path else { return }
            image = await ImageCache.load(path, with: state.client)
        }
    }
}

struct AttachmentThumb: View {
    @Environment(AppState.self) private var state
    let attachment: Attachment
    @State private var image: UIImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ZStack {
                Color.appFill
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                } else {
                    Image(systemName: icon).font(.title2).foregroundStyle(.secondary)
                }
            }
            .frame(height: 84)
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            Text(attachment.filename).font(.caption2).lineLimit(1).truncationMode(.middle)
            Text(Format.size(attachment.size)).font(.caption2).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .task(id: attachment.id) { await loadImage() }
    }

    private var icon: String {
        switch attachment.kind {
        case "image": "photo"
        case "video": "play.rectangle"
        case "log": "doc.text"
        default: "doc"
        }
    }

    private func loadImage() async {
        guard attachment.kind == "image", attachment.mime != "image/svg+xml" else { return }
        image = await ImageCache.load(attachment.url, with: state.client)
    }
}

extension Attachment {
    var isPicture: Bool { kind == "image" && mime != "image/svg+xml" }
    var isPage: Bool { mime == "text/html" }
    var isText: Bool { kind == "log" || mime == "image/svg+xml" }
    /// Opens inside the app; anything else is a file to take elsewhere.
    var canPreview: Bool { isPicture || kind == "video" || isText }
}

/// What the viewer was asked to show: one file among the files of its task.
struct ViewerRequest: Identifiable {
    let files: [Attachment]
    let start: Attachment

    var id: Int { start.id }

    init(_ start: Attachment, among all: [Attachment]) {
        let previews = all.filter(\.canPreview)
        files = previews.contains(start) ? previews : [start]
        self.start = start
    }
}

/// One attachment large, the rest of the task's files a swipe away.
struct AttachmentViewer: View {
    @Environment(\.dismiss) private var dismiss
    let request: ViewerRequest
    @State private var current: Int?

    private var shown: Attachment {
        request.files.first { $0.id == current } ?? request.start
    }

    var body: some View {
        NavigationStack {
            TabView(selection: $current) {
                ForEach(request.files) { file in
                    AttachmentPage(attachment: file, active: file.id == shown.id)
                        .tag(Optional(file.id))
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if request.files.count > 1 { strip }
            }
            .navigationTitle(shown.filename)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } }
                if request.files.count > 1 {
                    ToolbarItem(placement: .topBarLeading) {
                        let index = (request.files.firstIndex(of: shown) ?? 0) + 1
                        Text("\(index) из \(request.files.count)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }
            }
            .onAppear { if current == nil { current = request.start.id } }
        }
    }

    private var strip: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(request.files) { file in
                        Button {
                            withAnimation { current = file.id }
                        } label: {
                            StripThumb(attachment: file)
                                .overlay {
                                    RoundedRectangle(cornerRadius: 6)
                                        .stroke(file.id == shown.id ? Color.primary : .clear, lineWidth: 2)
                                }
                                .opacity(file.id == shown.id ? 1 : 0.55)
                        }
                        .buttonStyle(.plain)
                        .id(file.id)
                        .accessibilityLabel(file.filename)
                        .accessibilityAddTraits(file.id == shown.id ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
            }
            .background(.bar)
            .onChange(of: current) { _, new in
                withAnimation { proxy.scrollTo(new, anchor: .center) }
            }
        }
    }
}

private struct StripThumb: View {
    let attachment: Attachment

    var body: some View {
        ZStack {
            Color.appFill
            if attachment.isPicture {
                RemoteImage(path: attachment.url) { Color.clear }
            } else if attachment.kind == "video" {
                Image(systemName: "play.fill").font(.caption)
            } else {
                Text((attachment.filename.split(separator: ".").last.map(String.init) ?? "file").prefix(4).uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 56, height: 42)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

private struct AttachmentPage: View {
    @Environment(AppState.self) private var state
    let attachment: Attachment
    /// The page on screen; the neighbours are kept ready by the pager.
    let active: Bool

    @State private var image: UIImage?
    @State private var text: String?
    @State private var player: AVPlayer?
    @State private var error: String?
    @State private var asSource = false

    private static let textLimit = 400_000

    var body: some View {
        Group {
            if let image {
                ZoomableImage(image: image)
            } else if let player {
                VideoPlayer(player: player)
            } else if attachment.isPage, !asSource, let client = state.client {
                // The server sends the page with a sandbox policy: it gets an origin of its own
                // and no network, so it cannot reach the tracker with the user's session.
                PageView(client: client, path: attachment.url)
            } else if let text {
                ScrollView([.horizontal, .vertical]) {
                    Text(text)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .padding()
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if let error {
                ContentUnavailableView(attachment.filename, systemImage: "doc", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .topTrailing) {
            if attachment.isPage {
                Button(asSource ? "Страница" : "Исходный код") { asSource.toggle() }
                    .font(.footnote)
                    .buttonStyle(.bordered)
                    .background(.bar, in: Capsule())
                    .padding(10)
            }
        }
        .task { await load() }
        .onChange(of: active) { _, now in
            if !now { player?.pause() }
        }
        .onDisappear { player?.pause() }
    }

    private func load() async {
        guard let client = state.client else { return }
        do {
            if attachment.kind == "video" {
                let asset = AVURLAsset(
                    url: try client.url(attachment.url),
                    options: ["AVURLAssetHTTPHeaderFieldsKey": client.authHeaders])
                player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
            } else if attachment.isPicture {
                guard let loaded = UIImage(data: try await client.data(attachment.url)) else {
                    error = "Не удалось открыть изображение"
                    return
                }
                image = loaded
            } else if attachment.isText {
                let data = try await client.data(attachment.url)
                let shown = String(decoding: data.suffix(Self.textLimit), as: UTF8.self)
                text = data.count > Self.textLimit ? "… показан конец файла …\n" + shown : shown
            } else {
                error = "\(Format.size(attachment.size)) · \(attachment.mime)\nЭтот тип файла откройте в веб-версии."
            }
        } catch {
            self.error = state.message(for: error)
        }
    }
}

/// Pinch or double tap to zoom, drag to look around.
private struct ZoomableImage: View {
    let image: UIImage
    @State private var scale: CGFloat = 1
    @State private var base: CGFloat = 1
    @State private var offset = CGSize.zero
    @State private var baseOffset = CGSize.zero

    var body: some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .scaleEffect(scale)
            .offset(offset)
            .gesture(
                MagnifyGesture()
                    .onChanged { scale = min(6, max(1, base * $0.magnification)) }
                    .onEnded { _ in
                        base = scale
                        if scale == 1 { reset() }
                    }
            )
            // Dragging belongs to the pager until the picture is zoomed in.
            .gesture(scale > 1 ? pan : nil)
            .onTapGesture(count: 2) {
                withAnimation {
                    if scale > 1 { reset() } else { scale = 2.5; base = 2.5 }
                }
            }
            .accessibilityAddTraits(.isImage)
    }

    private var pan: some Gesture {
        DragGesture()
            .onChanged {
                offset = CGSize(
                    width: baseOffset.width + $0.translation.width,
                    height: baseOffset.height + $0.translation.height)
            }
            .onEnded { _ in baseOffset = offset }
    }

    private func reset() {
        scale = 1
        base = 1
        offset = .zero
        baseOffset = .zero
    }
}

/// An HTML attachment shown as a page.
private struct PageView: UIViewRepresentable {
    let client: APIClient
    let path: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Nothing the page stores outlives the viewer.
        config.websiteDataStore = .nonPersistent()
        // Reports are written for a computer; without this a phone lays them out 980 points wide.
        config.userContentController.addUserScript(WKUserScript(
            source: """
                if (!document.querySelector('meta[name=viewport]')) {
                  const meta = document.createElement('meta');
                  meta.name = 'viewport';
                  meta.content = 'width=device-width, initial-scale=1';
                  document.head.appendChild(meta);
                }
                """,
            injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.allowsLinkPreview = false
        if let url = try? client.url(path, query: [.init(name: "render", value: "1")]) {
            var request = URLRequest(url: url)
            request.setValue("Bearer \(client.key)", forHTTPHeaderField: "Authorization")
            context.coordinator.home = url
            view.load(request)
        }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        var home: URL?

        /// The attachment itself and nothing else: links in it do not lead anywhere.
        func webView(
            _ webView: WKWebView, decidePolicyFor action: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            action.request.url == home || action.request.url?.scheme == "about" ? .allow : .cancel
        }
    }
}
