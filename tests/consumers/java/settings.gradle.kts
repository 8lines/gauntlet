import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

val repositoryValue = requireNotNull(providers.gradleProperty("gauntletRepository").orNull) {
    "gauntletRepository is required"
}
require(repositoryValue.length in 8..4096 && repositoryValue.none { it.code < 0x20 || it.code == 0x7f }) {
    "gauntletRepository must be a bounded local file URI"
}
val repositoryUri = URI(repositoryValue)
require(
    repositoryUri.scheme == "file" && repositoryUri.rawAuthority == null && repositoryUri.rawUserInfo == null &&
        repositoryUri.rawQuery == null && repositoryUri.rawFragment == null
) {
    "gauntletRepository must be a local file URI without authority, userinfo, query, or fragment"
}
val repositoryPath = Path.of(repositoryUri)
require(
    repositoryPath.isAbsolute && repositoryPath.normalize() == repositoryPath &&
        Files.isDirectory(repositoryPath) && !Files.isSymbolicLink(repositoryPath) &&
        repositoryPath.toRealPath() == repositoryPath
) {
    "gauntletRepository must name an existing canonical local directory"
}
val metadataMode = providers.gradleProperty("gauntletMetadataMode").getOrElse("gradle")
require(metadataMode == "gradle" || metadataMode == "pom") {
    "gauntletMetadataMode must be gradle or pom"
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        exclusiveContent {
            forRepository {
                maven {
                    name = "gauntletStaged"
                    url = uri(repositoryPath.toUri())
                    metadataSources {
                        if (metadataMode == "gradle") gradleMetadata()
                        mavenPom()
                        artifact()
                    }
                }
            }
            filter {
                includeGroup("dev.eightlines.gauntlet")
            }
        }
        maven {
            name = "boundedMavenCentral"
            url = uri("https://repo.maven.apache.org/maven2")
            mavenContent { releasesOnly() }
            metadataSources {
                mavenPom()
                artifact()
            }
            content {
                excludeGroup("dev.eightlines.gauntlet")
            }
        }
    }
}

rootProject.name = "gauntlet-published-java-consumer"
