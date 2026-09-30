import org.gradle.api.tasks.testing.Test

plugins {
    id("com.diffplug.spotless")
    id("maven-publish")
}

dependencies {
    api(project(":core"))
    api(platform("org.springframework.boot:spring-boot-dependencies:4.1.1"))
    // Spring Boot 4.1.1 manages Jackson 3.1.5; pin 3.1.7 for current security fixes.
    api(platform("tools.jackson:jackson-bom:3.1.7"))
    api("org.springframework.boot:spring-boot-starter-webmvc")
    api("org.springframework.boot:spring-boot-starter-validation")
    api("org.apache.tomcat.embed:tomcat-embed-core:11.0.25")
    api("org.apache.tomcat.embed:tomcat-embed-el:11.0.25")
    api("org.apache.tomcat.embed:tomcat-embed-websocket:11.0.25")
    annotationProcessor(platform("org.springframework.boot:spring-boot-dependencies:4.1.1"))
    annotationProcessor("org.springframework.boot:spring-boot-configuration-processor")
    testImplementation(platform("org.springframework.boot:spring-boot-dependencies:4.1.1"))
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.boot:spring-boot-starter-webmvc-test")
}

tasks.named("compileJava") {
    inputs.files(tasks.named("processResources"))
}

spotless {
    java {
        target("src/main/java/**/*.java", "src/test/java/**/*.java")
        googleJavaFormat("1.36.1")
    }
}

val protocolFixtures = providers.systemProperty("gauntletProtocolFixtures")
sourceSets.named("test") {
    if (protocolFixtures.isPresent) {
        resources.srcDir(protocolFixtures)
    }
}
tasks.named<Test>("test") {
    systemProperty("gauntletProtocolFixtures", protocolFixtures.getOrElse(""))
    doFirst {
        require(protocolFixtures.isPresent) {
            "-DgauntletProtocolFixtures must name the mounted protocol fixture directory"
        }
    }
}

tasks.named("check") {
    dependsOn(":starter-api-consumer-test:compileJava")
}

publishing {
    publications {
        create<MavenPublication>("springBootStarter") {
            from(components["java"])
            artifactId = "spring-boot-starter"
            pom {
                name.set("Gauntlet Spring Boot Starter")
                description.set("Spring Boot auto-configuration and Adapter v1 HTTP transport for explicitly registered Gauntlet features.")
            }
        }
    }
}
