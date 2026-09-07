import Foundation

/// Release-time storefront configuration. The checkout address belongs in the
/// packaged app's Info.plist, never as a fake URL in source code.
public enum PurchaseConfiguration {
    public static let infoPlistKey = "NDMPurchaseURL"

    public static func purchaseURL(
        infoDictionary: [String: Any]? = Bundle.main.infoDictionary
    ) -> URL? {
        guard let raw = infoDictionary?[infoPlistKey] as? String,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "https",
              url.host?.isEmpty == false else {
            return nil
        }
        return url
    }
}
