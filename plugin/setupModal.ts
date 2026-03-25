import { App, Modal, Setting, Notice } from "obsidian";
import { VaultManager } from "./vaultManager.ts";

export class SetupModal extends Modal {
    private pass1 = "";
    private pass2 = "";

    private resolved = false;

    constructor(
        app: App, 
        private vaultManager: VaultManager, 
        private isFirstTime: boolean,
        private onResolved?: () => void,
        private onRejected?: (err: Error) => void
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: this.isFirstTime ? "Welcome to UWU-Crypt" : "Unlock Vault" });
        
        if (this.isFirstTime) {
            contentEl.createEl("p", { 
                text: "You are about to set up a new encryption vault. This involves 2 passwords. " +
                      "If you lose these passwords OR delete the .uwu folder, you WILL lose your data permanently." +
                      "Depending on your hardware, this may take a while." +
                      "Be patient (✿◡‿◡)"
            });
        }

        new Setting(contentEl)
            .setName("Password 1")
            .setDesc("A simple word or phrase.")
            .addText((text) =>
                text.setPlaceholder("...")
                    .onChange((value) => (this.pass1 = value))
                    .inputEl.type = "password"
            );

        new Setting(contentEl)
            .setName("Password 2")
            .setDesc("Another simple word or phrase.")
            .addText((text) =>
                text.setPlaceholder("...")
                    .onChange((value) => (this.pass2 = value))
                    .inputEl.type = "password"
            );

        new Setting(contentEl)
            .addButton((btn) =>
                btn.setButtonText(this.isFirstTime ? "Initialize Vault" : "Unlock")
                    .setCta()
                    .onClick(async () => {
                        try {
                            if (this.isFirstTime) {
                                await this.vaultManager.createVault(this.pass1, this.pass2);
                            } else {
                                await this.vaultManager.unlockVault(this.pass1, this.pass2);
                            }
                            this.resolved = true;
                            if (this.onResolved) this.onResolved();
                            this.close();
                        } catch (err: any) {
                            new Notice(`Error: ${err.message}`);
                        }
                    })
            );
    }

    onClose() {
        if (!this.resolved && this.onRejected) {
            this.onRejected(new Error("User cancelled vault unlock"));
        }
        // Zeroize passwords on modal close
        this.pass1 = "";
        this.pass2 = "";
        
        const { contentEl } = this;
        contentEl.empty();
    }
}
