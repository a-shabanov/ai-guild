import SwiftUI
import UIKit

/// Colours of the app. In the light theme they are the system ones; the dark theme is grey-blue
/// instead of the system black and grey.
enum Palette {
    /// Behind everything: screens, grouped lists.
    static let background = dynamic(light: .systemGroupedBackground, dark: 0x121A26)
    /// Screens that are one surface: plain lists, the timeline.
    static let surface = dynamic(light: .systemBackground, dark: 0x121A26)
    /// Cards, list rows, the board columns.
    static let card = dynamic(light: .secondarySystemGroupedBackground, dark: 0x1C2635)
    /// Something on a card: task cards on the board, the timeline grid.
    static let raised = dynamic(light: .systemBackground, dark: 0x263245)
    /// Tint over the blur of the tab bar and navigation bar; the light theme keeps the plain blur.
    static let bar = dynamic(light: .clear, dark: 0x161F2D, alpha: 0.85)
    /// Chips, placeholders.
    static let fill = dynamic(light: .secondarySystemFill, dark: 0x8CA5C8, alpha: 0.16)
    static let strongFill = dynamic(light: .tertiarySystemFill, dark: 0x8CA5C8, alpha: 0.24)
    static let separator = dynamic(light: .separator, dark: 0x8CA5C8, alpha: 0.18)

    private static func dynamic(light: UIColor, dark: UInt32, alpha: CGFloat = 1) -> UIColor {
        UIColor { traits in
            guard traits.userInterfaceStyle == .dark else { return light }
            return UIColor(
                red: CGFloat((dark >> 16) & 0xFF) / 255,
                green: CGFloat((dark >> 8) & 0xFF) / 255,
                blue: CGFloat(dark & 0xFF) / 255,
                alpha: alpha)
        }
    }

    /// Tab bar and navigation bar, which SwiftUI draws with UIKit.
    static func applyToUIKit() {
        let tab = UITabBarAppearance()
        tab.configureWithDefaultBackground()
        tab.backgroundColor = bar
        tab.shadowColor = separator
        UITabBar.appearance().standardAppearance = tab

        let navigation = UINavigationBarAppearance()
        navigation.configureWithDefaultBackground()
        navigation.backgroundColor = bar
        navigation.shadowColor = separator
        UINavigationBar.appearance().standardAppearance = navigation
        UINavigationBar.appearance().compactAppearance = navigation
    }
}

extension Color {
    static let appBackground = Color(uiColor: Palette.background)
    static let appSurface = Color(uiColor: Palette.surface)
    static let appCard = Color(uiColor: Palette.card)
    static let appRaised = Color(uiColor: Palette.raised)
    static let appFill = Color(uiColor: Palette.fill)
    static let appStrongFill = Color(uiColor: Palette.strongFill)
    static let appSeparator = Color(uiColor: Palette.separator)
}

/// A List in the app colours. Grouped lists and forms get card rows on the app background;
/// a plain list is one surface.
struct ThemedList<Content: View>: View {
    var plain = false
    @ViewBuilder var content: Content

    var body: some View {
        List {
            // A Group hands the row modifiers to every section and row inside.
            Group { content }
                .listRowBackground(plain ? Color.appSurface : Color.appCard)
                .listRowSeparatorTint(.appSeparator)
                .listSectionSeparatorTint(.appSeparator)
        }
        .scrollContentBackground(.hidden)
        .background(plain ? Color.appSurface : Color.appBackground)
    }
}
