import XCTest
@testable import NDMEngine

final class PackageIconPeekTests: XCTestCase {
    func testReadsBundlePathsFromPackageInfo() {
        let xml = """
        <pkg-info identifier="com.sangfor.EasyConnect">
            <bundle path="./EasyConnect.app/Contents/Frameworks/EasyConnect Helper.app" id="com.sangfor.Easyconnect.helper"/>
            <bundle path="./EasyConnect.app" id="com.sangfor.Easyconnect"/>
            <bundle path="./EasyConnect.app/Contents/Resources/bin/CSClient.app" id="com.sangfor.CSClient"/>
        </pkg-info>
        """
        XCTAssertEqual(
            PackageIconPeek.bundlePaths(in: xml),
            [
                "./EasyConnect.app/Contents/Frameworks/EasyConnect Helper.app",
                "./EasyConnect.app",
                "./EasyConnect.app/Contents/Resources/bin/CSClient.app",
            ]
        )
    }

    func testPrimaryAppCollapsesNestedHelpers() {
        let bundles = [
            "./EasyConnect.app/Contents/Frameworks/EasyConnect Helper.app",
            "./EasyConnect.app",
            "./EasyConnect.app/Contents/Resources/bin/CSClient.app",
        ]
        XCTAssertEqual(
            PackageIconPeek.primaryAppPath(
                bundlePaths: bundles,
                preferredName: "EasyConnect_7_6_7_4.dmg"
            ),
            "./EasyConnect.app"
        )
    }
}
