bits 64
global _start

section .data
prompt db 'Type your name in Virtual TTY, then press Send: '
prompt_len equ $ - prompt
hello db 'Hello, '
hello_len equ $ - hello

section .bss
buffer resb 128

section .text
_start:
    mov eax, 1
    mov edi, 1
    lea rsi, [rel prompt]
    mov edx, prompt_len
    syscall

.read_again:
    xor eax, eax
    xor edi, edi
    lea rsi, [rel buffer]
    mov edx, 127
    syscall
    test rax, rax
    jz .read_again
    mov r12, rax

    mov eax, 1
    mov edi, 1
    lea rsi, [rel hello]
    mov edx, hello_len
    syscall

    mov eax, 1
    mov edi, 1
    lea rsi, [rel buffer]
    mov rdx, r12
    syscall

    mov eax, 60
    xor edi, edi
    syscall
