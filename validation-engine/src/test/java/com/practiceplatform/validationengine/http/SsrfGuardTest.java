package com.practiceplatform.validationengine.http;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

class SsrfGuardTest {

    private final SsrfGuard guard = new SsrfGuard();

    @ParameterizedTest
    @ValueSource(strings = {
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.5",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "::1",
            "fc00::1",
            "fd12:3456::1"
    })
    void blocksAddressesInReservedRanges(String ip) {
        assertThrows(SsrfGuard.BlockedHostException.class, () -> guard.check(ip));
    }

    @ParameterizedTest
    @ValueSource(strings = {"8.8.8.8", "1.1.1.1", "93.184.216.34"})
    void allowsPublicAddresses(String ip) {
        assertDoesNotThrow(() -> guard.check(ip));
    }
}
